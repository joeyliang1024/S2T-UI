const { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } = require('node:fs/promises')
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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const lockTimeoutMs = 15_000
const staleLockMs = 60_000

// Coordinate mutations both inside this Node process and between separate
// gateway/Electron processes using the same local data directory. The lock is
// deliberately beside the data file, so atomic rename never replaces it.
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}
// Reaping a stale lock by path is racy: between judging the file stale and
// deleting it, another process may have reaped it and created a fresh lock at
// the same path. Renaming to a private quarantine name first means only one
// reaper can win a given file, and the inode check afterwards guarantees we
// never discard a lock we did not inspect.
const reclaimLock = async (lock, stale) => {
  const quarantine = `${lock}.stale-${randomUUID()}`
  try { await rename(lock, quarantine) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
  const info = await stat(quarantine).catch(() => null)
  if (info && info.ino === stale.ino) { await rm(quarantine, { force: true }).catch(() => undefined); return }
  await rename(quarantine, lock).catch(() => undefined)
}
const withFileLock = async (file, operation) => {
  const lock = `${file}.lock`
  const deadline = Date.now() + lockTimeoutMs
  let handle
  while (!handle) {
    try {
      await mkdir(join(file, '..'), { recursive: true })
      handle = await open(lock, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = await stat(lock).catch(() => null)
      if (info) {
        const age = Date.now() - info.mtimeMs
        const holder = await readFile(lock, 'utf8').then((text) => Number.parseInt(String(text).split('\n')[0], 10)).catch(() => NaN)
        // Reap only locks whose owning process is gone, so a live holder that
        // runs long fails the wait below instead of having its lock stolen.
        // The multiplied age is a safety valve for pid namespaces where the
        // original owner is not observable (for example a stale lock copied
        // between containers sharing this directory).
        if ((age > staleLockMs && !processAlive(holder)) || age > staleLockMs * 10) { await reclaimLock(lock, info); continue }
      }
      if (Date.now() >= deadline) throw new Error('本機 storage 正由另一個程序寫入，請稍後重試')
      await delay(20 + Math.floor(Math.random() * 30))
    }
  }
  try { return await operation() } finally {
    await handle.close().catch(() => undefined)
    await rm(lock, { force: true }).catch(() => undefined)
  }
}

// A local store can be constructed more than once in one process. Keep every
// read-modify-write operation for a backing file serialized so updates are not
// silently lost when requests arrive together.
const mutations = new Map()
const mutateFile = (file, operation) => {
  const queued = (mutations.get(file) || Promise.resolve()).catch(() => undefined).then(() => withFileLock(file, operation))
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
  constructor(root) { this.file = join(root, 'config.json'); this.schemaVersion = 'local-v1' }
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
  // Atomic read-modify-write for records shared by concurrent requests and
  // tabs (compensation queues, the voiceprints index, revoked tokens). The
  // transform runs inside the per-file mutation queue and the cross-process
  // lock, so a concurrent writer can never overwrite what it did not see.
  // Returning undefined aborts without writing.
  async update(scope, recordKey, transform) {
    return mutateFile(this.file, async () => {
      const records = await this.records(); const key = this.key(scope, recordKey)
      const current = records[key]?.value ?? null
      const outcome = await transform(current)
      if (outcome === undefined) return { changed: false, value: current }
      records[key] = { value: outcome, updatedAt: new Date().toISOString() }; await atomicJson(this.file, records)
      return { changed: true, value: outcome }
    })
  }
  async list(scope, prefix = '') {
    const records = await this.records(); const start = `${safePart(scope, 'scope')}:`; const cleanPrefix = prefix ? safePart(prefix, 'prefix') : ''
    return Object.entries(records).flatMap(([key, entry]) => key.startsWith(start) && key.slice(start.length).startsWith(cleanPrefix) ? [{ key: key.slice(start.length), value: entry.value, updatedAt: entry.updatedAt }] : [])
  }
  async mutateDiarizationJobs(transform) {
    let result
    await this.update('diarization-system', 'jobs', current => {
      const jobs = current?.jobs || []
      const before = JSON.stringify(jobs)
      result = transform(jobs)
      return before === JSON.stringify(jobs) ? undefined : { jobs }
    })
    return result
  }
  async enqueueDiarizationJob({ id, userId, sessionId, audioKey, payload }) {
    for (const [value, label] of [[id, 'job id'], [userId, 'user id'], [sessionId, 'session id'], [audioKey, 'audio key']]) safePart(value, label)
    return this.mutateDiarizationJobs(jobs => {
      const now = new Date().toISOString()
      let job = jobs.find(j => j.userId === userId && j.sessionId === sessionId && j.audioKey === audioKey)
      if (!job) { job = { id, userId, sessionId, audioKey, createdAt: now, leaseGeneration: 0 }; jobs.push(job) }
      Object.assign(job, { payload, state: 'queued', attempts: 0, leaseOwner: null, leaseUntil: null, error: null, updatedAt: now })
      return { ...job }
    })
  }
  async getDiarizationJob(userId, id) {
    safePart(userId, 'user id'); safePart(id, 'job id')
    const stored = await this.get('diarization-system', 'jobs')
    const job = stored?.jobs?.find(j => j.userId === userId && j.id === id)
    return job ? { id: job.id, state: job.state, attempts: job.attempts, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt } : null
  }
  async removeDiarizationJob(userId, id) {
    safePart(userId, 'user id'); safePart(id, 'job id')
    await this.mutateDiarizationJobs(jobs => { const index = jobs.findIndex(j => j.userId === userId && j.id === id); if (index >= 0) jobs.splice(index, 1) })
  }
  async claimDiarizationJob(owner, id = null) {
    safePart(owner, 'job owner'); if (id) safePart(id, 'job id')
    return this.mutateDiarizationJobs(jobs => {
      const now = Date.now()
      const job = jobs.filter(j => (!id || j.id === id) && ['queued', 'running'].includes(j.state) && (!j.leaseUntil || j.leaseUntil < now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
      if (!job) return null
      Object.assign(job, { state: 'running', attempts: job.attempts + 1, leaseGeneration: job.leaseGeneration + 1, leaseOwner: owner, leaseUntil: now + 300000, updatedAt: new Date(now).toISOString() })
      return { ...job }
    })
  }
  async stillOwnsDiarizationJob(id, owner, generation) {
    safePart(id, 'job id'); safePart(owner, 'job owner')
    const stored = await this.get('diarization-system', 'jobs')
    return Boolean(stored?.jobs?.some(j => j.id === id && j.state === 'running' && j.leaseOwner === owner && j.leaseGeneration === generation && j.leaseUntil > Date.now()))
  }
  async renewDiarizationJob(id, owner, generation) {
    safePart(id, 'job id'); safePart(owner, 'job owner')
    return this.mutateDiarizationJobs(jobs => {
      const job = jobs.find(j => j.id === id && j.state === 'running' && j.leaseOwner === owner && j.leaseGeneration === generation && j.leaseUntil > Date.now())
      if (!job) return false
      job.leaseUntil = Date.now() + 300000; job.updatedAt = new Date().toISOString()
      return true
    })
  }
  async finishDiarizationJob(id, owner, generation, error = null) {
    safePart(id, 'job id'); safePart(owner, 'job owner')
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('無效的工作租約 generation')
    await this.mutateDiarizationJobs(jobs => {
      const job = jobs.find(j => j.id === id && j.leaseOwner === owner && j.leaseGeneration === generation)
      if (!job) return
      const retry = typeof error === 'string' && error.startsWith('retry:')
      Object.assign(job, { state: retry ? 'queued' : error ? 'failed' : 'completed', error: error ? String(error).replace(/^retry:/, '').slice(0, 1000) : null, leaseOwner: null, leaseUntil: retry ? Date.now() + Math.min(60, Math.max(5, job.attempts * 5)) * 1000 : null, updatedAt: new Date().toISOString() })
    })
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
  async put(scope, key, bytes) {
    const target = this.path(scope, key)
    await mkdir(join(target, '..'), { recursive: true })
    // Stream to a temp file beside the blob root and rename into place: a
    // reader (or a crash) can never observe a half-written recording, and the
    // temp name lives outside every scope directory so list() never sees it.
    const temporary = join(this.root, `.tmp-${randomUUID()}`)
    try { await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, target) } finally { await rm(temporary, { force: true }) }
  }
  async get(scope, key) { try { return await readFile(this.path(scope, key)) } catch (error) { if (error && error.code === 'ENOENT') return null; throw error } }
  stream(scope, key) { return createReadStream(this.path(scope, key)) }
  async remove(scope, key) { await rm(this.path(scope, key), { force: true }) }
  async list(scope, prefix = '') {
    const root = prefix ? this.path(scope, prefix) : this.path(scope, 'placeholder').replace(/placeholder$/, '')
    const walk = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))
      const files = []
      for (const entry of entries) { const target = join(directory, entry.name); if (entry.isDirectory()) files.push(...await walk(target)); else if (entry.isFile()) files.push(relative(this.root, target).split(sep).slice(1).join('/')) }
      return files
    }
    return walk(root)
  }
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
  async getMany(ids) {
    const permitted = new Set(ids.map((id) => safePart(id, 'vector id')))
    return (await this.records()).filter((item) => permitted.has(item.id)).map((item) => ({ ...item, embedding: [...item.embedding] }))
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
