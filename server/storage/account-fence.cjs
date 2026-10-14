const { mkdir, readdir, rm, stat, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')

const accountError = (status, code, message) => Object.assign(new Error(message), { status, code })
const validUserId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const pause = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}
const lockOwner = async (file) => {
  const [pid, createdAt] = (await require('node:fs/promises').readFile(file, 'utf8')).trim().split('\n')
  return { pid: Number.parseInt(pid, 10), createdAt: Number(createdAt) || 0 }
}

class LocalAccountFence {
  constructor(root, getUserState, { drainTimeoutMs = 15_000 } = {}) { this.root = join(root, '.account-fences'); this.getUserState = getUserState; this.drainTimeoutMs = drainTimeoutMs }
  paths(userId) { if (!validUserId(userId)) throw accountError(400, 'INVALID_ACCOUNT', '無效的帳號識別碼'); return { deleting: join(this.root, `${userId}.deleting`), deletionLock: join(this.root, `${userId}.delete-lock`), writers: `${userId}.writer-` } }
  async writable(userId) {
    const state = await this.getUserState(userId)
    if (state === 'deleting') throw accountError(409, 'ACCOUNT_DELETING', '帳號正在刪除中')
    if (state !== 'active') throw accountError(401, 'ACCOUNT_UNAVAILABLE', '帳號已不存在')
  }
  async reclaimIfStale(file) {
    const owner = await lockOwner(file).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    // A long ASR/diarization write is still a live writer. Age alone is never
    // evidence that it is safe to reclaim its lease.
    if (!owner || processAlive(owner.pid)) return false
    const quarantine = `${file}.stale-${randomUUID()}`
    try { await require('node:fs/promises').rename(file, quarantine) } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
    await rm(quarantine, { force: true })
    return true
  }
  async withWrite(userId, operation) {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await this.writable(userId)
    const paths = this.paths(userId); const writer = join(this.root, `${paths.writers}${randomUUID()}`)
    await writeFile(writer, `${process.pid}\n${Date.now()}\n`, { flag: 'wx', mode: 0o600 })
    try {
      if (await stat(paths.deleting).then(() => true).catch(error => error?.code === 'ENOENT' ? false : Promise.reject(error))) throw accountError(409, 'ACCOUNT_DELETING', '帳號正在刪除中')
      await this.writable(userId)
      return await operation()
    } finally { await rm(writer, { force: true }) }
  }
  async withDeletion(userId, operation) {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const paths = this.paths(userId); const deadline = Date.now() + this.drainTimeoutMs
    for (;;) {
      try { await writeFile(paths.deletionLock, `${process.pid}\n${Date.now()}\n`, { flag: 'wx', mode: 0o600 }); break } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        if (await this.reclaimIfStale(paths.deletionLock)) continue
        if (Date.now() >= deadline) throw accountError(409, 'ACCOUNT_DELETING', '帳號刪除正在進行中')
        await pause(25)
      }
    }
    try {
      await writeFile(paths.deleting, `${process.pid}\n${Date.now()}\n`, { flag: 'a', mode: 0o600 })
      for (;;) {
        const writers = (await readdir(this.root)).filter(name => name.startsWith(paths.writers))
        const active = (await Promise.all(writers.map(async name => {
          const file = join(this.root, name)
          return !await this.reclaimIfStale(file)
        }))).some(Boolean)
        if (!active) break
        if (Date.now() >= deadline) throw accountError(503, 'ACCOUNT_WRITES_DRAINING', '帳號寫入尚未排空，請重試')
        await pause(20)
      }
      return await operation()
    } finally { await rm(paths.deletionLock, { force: true }) }
  }
}

class PostgresAccountFence {
  constructor(pool, getUserState) { this.pool = pool; this.getUserState = getUserState }
  async withLock(userId, mode, operation) {
    if (!validUserId(userId)) throw accountError(400, 'INVALID_ACCOUNT', '無效的帳號識別碼')
    const client = await this.pool.connect()
    try {
      const lock = mode === 'shared' ? 'pg_advisory_lock_shared' : 'pg_advisory_lock'
      await client.query(`SELECT ${lock}(hashtext('s2t_account_fence:' || $1))`, [userId])
      if (mode === 'shared') {
        const state = await this.getUserState(userId, client)
        if (state === 'deleting') throw accountError(409, 'ACCOUNT_DELETING', '帳號正在刪除中')
        if (state !== 'active') throw accountError(401, 'ACCOUNT_UNAVAILABLE', '帳號已不存在')
      }
      return await operation()
    } finally {
      const unlock = mode === 'shared' ? 'pg_advisory_unlock_shared' : 'pg_advisory_unlock'
      await client.query(`SELECT ${unlock}(hashtext('s2t_account_fence:' || $1))`, [userId]).catch(() => undefined)
      client.release()
    }
  }
  withWrite(userId, operation) { return this.withLock(userId, 'shared', operation) }
  withDeletion(userId, operation) { return this.withLock(userId, 'exclusive', operation) }
}

const createAccountFence = ({ localDataDirectory, pool, getUserState }) => pool
  ? new PostgresAccountFence(pool, getUserState)
  : new LocalAccountFence(localDataDirectory, getUserState)

module.exports = { createAccountFence, LocalAccountFence, PostgresAccountFence }
