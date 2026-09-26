const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { join, resolve, relative, sep } = require('node:path')

const safePart = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new Error(`無效的 ${label}`)
  return value
}
const inside = (root, target) => {
  const difference = relative(root, target)
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..')
}
const atomicJson = async (file, value) => {
  await mkdir(join(file, '..'), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

// A local store can be constructed more than once in one process. Keep every
// read-modify-write operation for a backing file serialized so updates are not
// silently lost when requests arrive together.
const mutations = new Map()
const mutateFile = (file, operation) => {
  const queued = (mutations.get(file) || Promise.resolve()).catch(() => undefined).then(operation)
  mutations.set(file, queued)
  return queued.finally(() => { if (mutations.get(file) === queued) mutations.delete(file) })
}
const readJsonFile = async (file, fallback, label) => {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) throw new Error(`${label} 格式損毀，請先還原備份`)
    throw error
  }
}

class LocalConfigStore {
  constructor(root) { this.file = join(root, 'config.json') }
  async records() {
    const parsed = await readJsonFile(this.file, {}, '設定檔')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('設定檔格式損毀，請先還原備份')
    return parsed
  }
  key(scope, recordKey) { return `${safePart(scope, 'scope')}:${safePart(recordKey, 'record key')}` }
  async get(scope, recordKey) { return (await this.records())[this.key(scope, recordKey)]?.value ?? null }
  async put(scope, recordKey, value) {
    return mutateFile(this.file, async () => {
      const records = await this.records(); records[this.key(scope, recordKey)] = { value, updatedAt: new Date().toISOString() }; await atomicJson(this.file, records)
    })
  }
  async putIfAbsent(scope, recordKey, value) {
    return mutateFile(this.file, async () => {
      const records = await this.records(); const key = this.key(scope, recordKey)
      if (Object.hasOwn(records, key)) return false
      records[key] = { value, updatedAt: new Date().toISOString() }; await atomicJson(this.file, records)
      return true
    })
  }
  async compareAndSwap(scope, recordKey, expectedVersion, value) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('無效的資料版本')
    return mutateFile(this.file, async () => {
      const records = await this.records(); const key = this.key(scope, recordKey)
      const current = records[key]?.value
      const version = current && !Array.isArray(current) && Number.isSafeInteger(current.version) ? current.version : 0
      if (version !== expectedVersion) return false
      records[key] = { value, updatedAt: new Date().toISOString() }; await atomicJson(this.file, records)
      return true
    })
  }
  async remove(scope, recordKey) {
    return mutateFile(this.file, async () => { const records = await this.records(); delete records[this.key(scope, recordKey)]; await atomicJson(this.file, records) })
  }
  async list(scope, prefix = '') {
    const records = await this.records(); const start = `${safePart(scope, 'scope')}:`; const cleanPrefix = prefix ? safePart(prefix, 'prefix') : ''
    return Object.entries(records).flatMap(([key, entry]) => key.startsWith(start) && key.slice(start.length).startsWith(cleanPrefix) ? [{ key: key.slice(start.length), value: entry.value, updatedAt: entry.updatedAt }] : [])
  }
  async findVisibleVoiceprintIds({ userId, department, embeddingModel, embeddingVersion }) {
    const records = await this.records()
    return Object.entries(records).flatMap(([key, entry]) => {
      if (!key.endsWith(':voiceprints') || !Array.isArray(entry?.value)) return []
      const ownerId = key.slice(0, -':voiceprints'.length)
      return entry.value.filter((item) => item && typeof item.id === 'string' && item.embeddingModel === embeddingModel && item.embeddingVersion === embeddingVersion && (ownerId === userId || item.sharingScope === 'organization' || (item.sharingScope === 'department' && item.Department === department))).map((item) => item.id)
    })
  }
}

class LocalBlobStore {
  constructor(root) { this.root = resolve(root, 'blobs') }
  path(scope, key) {
    const target = resolve(this.root, safePart(scope, 'scope'), ...key.split('/').map((part) => safePart(part, 'blob key')))
    if (!inside(this.root, target)) throw new Error('無效的 blob key')
    return target
  }
  async put(scope, key, bytes) { const target = this.path(scope, key); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, bytes, { mode: 0o600 }) }
  async get(scope, key) { try { return await readFile(this.path(scope, key)) } catch (error) { if (error && error.code === 'ENOENT') return null; throw error } }
  stream(scope, key) { return createReadStream(this.path(scope, key)) }
  async remove(scope, key) { await rm(this.path(scope, key), { force: true }) }
}

class LocalVectorStore {
  constructor(root) { this.file = join(root, 'vectors.json') }
  async records() {
    const value = await readJsonFile(this.file, [], '聲紋檔')
    if (!Array.isArray(value)) throw new Error('聲紋檔格式損毀，請先還原備份')
    return value
  }
  async upsert(record) {
    return mutateFile(this.file, async () => {
      validateVectorRecord(record); const records = await this.records(); const index = records.findIndex((item) => item.id === record.id)
      if (index === -1) records.push(record); else records[index] = record; await atomicJson(this.file, records)
    })
  }
  async remove(id) {
    return mutateFile(this.file, async () => { const records = await this.records(); await atomicJson(this.file, records.filter((item) => item.id !== safePart(id, 'vector id'))) })
  }
  async nearest(embedding, limit = 5, allowedIds = []) {
    validateEmbedding(embedding)
    const permitted = new Set(allowedIds.map((id) => safePart(id, 'vector id')))
    if (!permitted.size) return []
    return (await this.records()).filter((item) => permitted.has(item.id) && item.embedding.length === embedding.length).map((item) => ({ id: item.id, NT: item.NT, Department: item.Department, score: cosine(embedding, item.embedding) })).sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

const validateEmbedding = (embedding) => {
  if (!Array.isArray(embedding) || embedding.length < 1 || embedding.length > 8192 || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('無效的聲紋 embedding')
}
const validateVectorRecord = (record) => {
  if (!record || typeof record !== 'object') throw new Error('無效的聲紋紀錄')
  safePart(record.id, 'vector id'); if (typeof record.NT !== 'string' || !record.NT.trim() || typeof record.Department !== 'string' || !record.Department.trim()) throw new Error('聲紋需要 NT 與 Department')
  validateEmbedding(record.embedding)
}
const cosine = (left, right) => { let dot = 0; let leftNorm = 0; let rightNorm = 0; for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2 } return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0 }

module.exports = { LocalBlobStore, LocalConfigStore, LocalVectorStore, safePart, validateEmbedding, validateVectorRecord }
