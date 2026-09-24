const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
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
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, file)
}

class LocalConfigStore {
  constructor(root) { this.file = join(root, 'config.json') }
  async records() {
    try { const parsed = JSON.parse(await readFile(this.file, 'utf8')); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
  }
  key(scope, recordKey) { return `${safePart(scope, 'scope')}:${safePart(recordKey, 'record key')}` }
  async get(scope, recordKey) { return (await this.records())[this.key(scope, recordKey)]?.value ?? null }
  async put(scope, recordKey, value) {
    const records = await this.records(); records[this.key(scope, recordKey)] = { value, updatedAt: new Date().toISOString() }; await atomicJson(this.file, records)
  }
  async remove(scope, recordKey) { const records = await this.records(); delete records[this.key(scope, recordKey)]; await atomicJson(this.file, records) }
  async list(scope, prefix = '') {
    const records = await this.records(); const start = `${safePart(scope, 'scope')}:`; const cleanPrefix = prefix ? safePart(prefix, 'prefix') : ''
    return Object.entries(records).flatMap(([key, entry]) => key.startsWith(start) && key.slice(start.length).startsWith(cleanPrefix) ? [{ key: key.slice(start.length), value: entry.value, updatedAt: entry.updatedAt }] : [])
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
  async records() { try { const value = JSON.parse(await readFile(this.file, 'utf8')); return Array.isArray(value) ? value : [] } catch { return [] } }
  async upsert(record) {
    validateVectorRecord(record); const records = await this.records(); const index = records.findIndex((item) => item.id === record.id)
    if (index === -1) records.push(record); else records[index] = record; await atomicJson(this.file, records)
  }
  async remove(id) { const records = await this.records(); await atomicJson(this.file, records.filter((item) => item.id !== safePart(id, 'vector id'))) }
  async nearest(embedding, limit = 5) {
    validateEmbedding(embedding); return (await this.records()).filter((item) => item.embedding.length === embedding.length).map((item) => ({ id: item.id, NT: item.NT, Department: item.Department, score: cosine(embedding, item.embedding) })).sort((a, b) => b.score - a.score).slice(0, limit)
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
