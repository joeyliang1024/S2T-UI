const { mkdir, readdir, rm, stat, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
const { writer } = require('./request-batches.cjs')
const { createConcurrencyGate } = require('../concurrency-gate.cjs')

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
  constructor(pool, getUserState, { batch = false } = {}) {
    this.pool = pool; this.getUserState = getUserState
    this.closing = false; this.operations = new Set()
    this.shared = null; this.readers = new Map(); this.failure = null; this.pending = new Set()
    this.serial = createConcurrencyGate({ maximum: 1, maxWaiting: 1000, waitMs: 3000 })
    if (batch) {
      this.admissions = writer(ids => this.serialize(async () => {
        await this.sharedClient()
        const unique = [...new Set(ids)], fresh = unique.filter(id => !this.readers.has(id))
        const locks = fresh.length ? await this.queryShared("SELECT id,pg_try_advisory_lock_shared(hashtext('s2t_account_fence:' || id)) AS acquired FROM unnest($1::text[]) AS id", [fresh]) : { rows: [] }
        const blocked = new Set(locks.rows.filter(row => !row.acquired).map(row => row.id))
        // Read after acquiring locks: a snapshot from before the advisory lock
        // could miss a deletion that completed just before lock acquisition.
        const states = await this.queryShared('SELECT id,deletion_state FROM s2t_users WHERE id=ANY($1::text[])', [unique])
        const active = new Set(states.rows.filter(row => row.deletion_state === 'active').map(row => row.id))
        const rejected = fresh.filter(id => !blocked.has(id) && !active.has(id))
        if (rejected.length) await this.queryShared("SELECT pg_advisory_unlock_shared(hashtext('s2t_account_fence:' || id)) FROM unnest($1::text[]) AS id", [rejected])
        return ids.map(id => {
          if (blocked.has(id) || !active.has(id)) return { error: accountError(409, 'ACCOUNT_DELETING', '帳號已不存在或正在刪除中') }
          this.readers.set(id, (this.readers.get(id) || 0) + 1)
          return {}
        })
      }), { concurrency: 1 })
      this.departures = writer(ids => this.serialize(async () => {
        const unlock = []
        for (const id of ids) {
          const count = this.readers.get(id) - 1
          if (count) this.readers.set(id,count)
          else { this.readers.delete(id); unlock.push(id) }
        }
        if (this.failure) throw this.failure
        if (unlock.length) await this.queryShared("SELECT pg_advisory_unlock_shared(hashtext('s2t_account_fence:' || id)) FROM unnest($1::text[]) AS id", [unlock])
        return ids.map(() => ({}))
      }, true), { concurrency: 1, waitMs: 0, maximumPending: Number.MAX_SAFE_INTEGER })
    }

  }
  // Only lock bookkeeping is serialized. Hundreds of slow uploads/model calls
  // share one PG session; none holds a query-pool connection while doing I/O.
  serialize(operation, cleanup = false) {
    const result = this.serial(operation, { cleanup })
    this.pending.add(result)
    result.then(() => this.pending.delete(result), () => this.pending.delete(result))
    return result
  }
  async sharedClient() {
    if (this.failure) {
      if (this.readers.size) throw this.failure
      this.shared?.release(this.failure); this.shared = null; this.failure = null
    }
    if (!this.shared) {
      this.shared = await this.pool.connect()
      const client = this.shared
      client.on?.('error', error => { if (this.shared === client) this.failure = error })
    }
    return this.shared
  }
  async queryShared(sql, values) {
    try { return await this.shared.query(sql, values) }
    catch (error) { this.failure = error; throw error }
  }
  withWrite(userId, operation) {
    if (this.closing) return Promise.reject(accountError(503, 'FENCE_CLOSED', '服務正在排空'))
    const pending = this.performWrite(userId, operation)
    this.operations.add(pending)
    pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending))
    return pending
  }
  async performWrite(userId, operation) {
    if (!validUserId(userId)) throw accountError(400, 'INVALID_ACCOUNT', '無效的帳號識別碼')
    if (this.admissions) {
      const result = await this.admissions.request(userId)
      if (result.error) throw result.error
    } else await this.serialize(async () => {
      const client = await this.sharedClient()
      const count = this.readers.get(userId) || 0
      if (!count) {
        // Never block this session on a deleting account: that would also
        // prevent releasing every other account's shared lock.
        const result = await this.queryShared("SELECT pg_try_advisory_lock_shared(hashtext('s2t_account_fence:' || $1)) AS acquired", [userId])
        if (!result.rows[0].acquired) throw accountError(409, 'ACCOUNT_DELETING', '帳號正在刪除中')
      }
      try {
        const state = await this.getUserState(userId, client).catch(error => { this.failure = error; throw error })
        if (state === 'deleting') throw accountError(409, 'ACCOUNT_DELETING', '帳號正在刪除中')
        if (state !== 'active') throw accountError(401, 'ACCOUNT_UNAVAILABLE', '帳號已不存在')
        this.readers.set(userId, count + 1)
      } catch (error) {
        if (!count) await this.queryShared("SELECT pg_advisory_unlock_shared(hashtext('s2t_account_fence:' || $1))", [userId]).catch(unlockError => { this.failure = unlockError })
        throw error
      }
    })
    try {
      const result = await operation()
      if (this.failure) throw this.failure
      return result
    } finally {
      if (this.departures) await this.departures.request(userId)
      else await this.serialize(async () => {
        const count = this.readers.get(userId) - 1
        if (count) this.readers.set(userId, count)
        else {
          this.readers.delete(userId)
          if (this.failure) throw this.failure
          await this.queryShared("SELECT pg_advisory_unlock_shared(hashtext('s2t_account_fence:' || $1))", [userId]).catch(error => { this.failure = error; throw error })
        }
      }, true)
    }
  }
  async withDeletion(userId, operation) {
    if (!validUserId(userId)) throw accountError(400, 'INVALID_ACCOUNT', '無效的帳號識別碼')
    // A separate session is essential: advisory locks are reentrant within a
    // session, so an exclusive lock there would bypass our active writers.
    const client = await this.pool.connect()
    let broken
    const onError = error => { broken = error }
    client.on?.('error', onError)
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('s2t_account_fence:' || $1))", [userId])
      return await operation()
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('s2t_account_fence:' || $1))", [userId]).catch(error => { broken = error })
      client.removeListener?.('error', onError)
      client.release(broken)
    }
  }
  async close() {
    this.closing = true
    await Promise.allSettled([...this.operations])
    await this.admissions?.close(); await this.departures?.close()
    await Promise.allSettled([...this.pending])
    if (this.shared) { this.shared.release(this.failure || true); this.shared = null }
  }
}

class PostgresAccountFenceGroup {
  constructor(pool, getUserState, sessions) {
    this.shards = Array.from({ length: sessions }, () => new PostgresAccountFence(pool, getUserState, { batch: true }))
  }
  withWrite(userId, operation) {
    if (!validUserId(userId)) return Promise.reject(accountError(400, 'INVALID_ACCOUNT', '無效的帳號識別碼'))
    // Stable bounded sharding parallelizes the short lock roundtrips. It does
    // not serialize user I/O or create one PG client per account/request.
    let hash = 2166136261
    for (const char of userId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    return this.shards[(hash >>> 0) % this.shards.length].withWrite(userId, operation)
  }
  withDeletion(userId, operation) { return this.shards[0].withDeletion(userId, operation) }
  close() { return Promise.all(this.shards.map(shard => shard.close())) }
}

const createAccountFence = ({ localDataDirectory, pool, getUserState, sharedSessions = 1 }) => pool
  ? sharedSessions > 1 ? new PostgresAccountFenceGroup(pool, getUserState, sharedSessions) : new PostgresAccountFence(pool, getUserState, { batch: true })
  : new LocalAccountFence(localDataDirectory, getUserState)

module.exports = { createAccountFence, LocalAccountFence, PostgresAccountFence, PostgresAccountFenceGroup }
