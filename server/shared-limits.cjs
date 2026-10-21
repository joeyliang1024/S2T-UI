const metrics = require('./metrics.cjs')
const { writer } = require('./storage/request-batches.cjs')
const { createBatchAdmission } = require('./capacity-admission.cjs')
const { createHash, randomUUID } = require('node:crypto')
const { redisConnection } = require('./redis-connection.cjs')
const { createRequestLimiter } = require('./request-limits.cjs')

// One atomic sliding-window operation, matching the standalone limiter's semantics.
const WINDOW = `
local now = redis.call('TIME'); now = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]))
local count = redis.call('ZCARD', KEYS[1])
if ARGV[3] == 'clear' then redis.call('DEL', KEYS[1]); return {1, 0, 0} end
-- Rediscovery may replay a command whose response was lost. Count its UUID once.
if ARGV[3] == 'take' and redis.call('ZSCORE', KEYS[1], ARGV[4]) then return {1, 0, count} end
if count >= tonumber(ARGV[2]) then
 local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
 return {0, math.max(1, math.ceil((tonumber(oldest[2]) + tonumber(ARGV[1]) - now) / 1000)), count}
end
if ARGV[3] == 'take' then
 redis.call('ZADD', KEYS[1], now, ARGV[4]); redis.call('PEXPIRE', KEYS[1], ARGV[1]); count = count + 1
end
return {1, 0, count}`

// Same per-account sliding-window semantics, one bounded Redis command for a
// burst. Redis TIME and UUID replay protection remain authoritative.
const WINDOW_BATCH = `
local now = redis.call('TIME'); now = now[1] * 1000 + math.floor(now[2] / 1000)
local function check(key, duration, maximum, action, member)
${WINDOW.slice(WINDOW.indexOf("redis.call('ZREMRANGEBYSCORE'"))
  .replaceAll('KEYS[1]', 'key').replaceAll('ARGV[1]', 'duration')
  .replaceAll('ARGV[2]', 'maximum').replaceAll('ARGV[3]', 'action').replaceAll('ARGV[4]', 'member')}
end
local results = {}
for i, key in ipairs(KEYS) do
 local n = (i - 1) * 4
 results[i] = check(key, ARGV[n+1], ARGV[n+2], ARGV[n+3], ARGV[n+4])
end
return results`

const ACQUIRE = `
local now = redis.call('TIME'); now = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + 120000, ARGV[2]); redis.call('PEXPIRE', KEYS[1], 120000); return 1`

const ACQUIRE_BATCH = `
local now = redis.call('TIME'); now = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = redis.call('ZCARD', KEYS[1])
local granted = {}
for i = 2, #ARGV do
 local token = ARGV[i]
 if redis.call('ZSCORE', KEYS[1], token) then
  table.insert(granted, token)
 elseif count < tonumber(ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + 120000, token)
  count = count + 1; table.insert(granted, token)
 else break end
end
if #granted > 0 then redis.call('PEXPIRE', KEYS[1], 120000) end
return granted`

const createSharedLimits = (env, limits, suppliedClient) => {
  const distributed = env.S2T_KUBERNETES_MODE === 'true'
  const local = createRequestLimiter(limits)
  const failures = new Map()
  const active = new Map()
  let client = suppliedClient
  let configurationError = null
  let closing = false, sentinelMode = false, retryTimer, retryResolve, needsReconciliation = false
  let ready = Promise.resolve()
  if (distributed) {
    try {
      const connection = redisConnection(env)
      sentinelMode = connection.mode === 'sentinel'
      const redis = require('redis')
      const newClient = () => connection.mode === 'sentinel' ? redis.createSentinel(connection.options) : redis.createClient(connection.options)
      client ||= newClient()
      client.on('error', () => undefined) // Never log credentials.
      client.on('ready', () => { needsReconciliation = true })
      client.on('topology-change', () => { needsReconciliation = true })
      ready = client.isOpen ? Promise.resolve() : (async () => {
        do {
          try { await client.connect(); return } catch {
            if (connection.mode !== 'sentinel') throw new Error('共享限流服務連線失敗')
            if (client.isOpen) {
              // A failed discovery may also reject destroy; retry cleanup after it settles.
              try { await client.destroy() } catch { await client.destroy().catch(() => undefined) }
            }
            if (closing) return
            client = newClient() // Destroyed Sentinel objects cannot be reused.
            client.on('error', () => undefined)
            client.on('ready', () => { needsReconciliation = true })
            client.on('topology-change', () => { needsReconciliation = true })
            await new Promise(resolve => { retryTimer = setTimeout(resolve, 1000); retryResolve = resolve })
          }
        } while (!closing)
      })()
    } catch (error) { configurationError = error }
    if (configurationError) ready = Promise.reject(configurationError)
  }
  ready.catch(() => undefined)
  let pending = 0
  let leaseOwner, commandLeases, leaseCursor = 0
  const commandClient = async () => {
    if (!sentinelMode || typeof client.acquire !== 'function') return null
    if (leaseOwner !== client) {
      leaseOwner = client
      // RedisSentinelClient constructs its complete command interface on acquire.
      // Build this bounded set once, then pipeline only non-sticky commands on
      // them. Sentinel reconnects their stable slot IDs to a new primary.
      commandLeases = Promise.all(Array.from({ length: redisConnection(env).options.masterPoolSize }, () => client.acquire()))
    }
    const leases = await commandLeases
    return leases[leaseCursor++ % leases.length]
  }
  let waitingCapacity = 0
  const admissions = new Map()
  const releases = new Map()
  const releasing = new Set()
  const flushRelease = async key => {
    const group = releases.get(key)
    if (!group) return
    releases.delete(key); clearTimeout(group.timer)
    if (client?.isReady) await command('zRem', key, [...group.tokens]).catch(() => { needsReconciliation = true })
    for (const resolve of group.waiters) resolve()
    admissions.get(key)?.notify()
  }
  const releaseCapacity = (key, token) => new Promise(resolve => {
    let group = releases.get(key)
    if (!group) {
      group = { tokens: new Set(), waiters: [], timer: setTimeout(() => { void flushRelease(key) }, 2) }
      releases.set(key, group)
    }
    group.tokens.add(token); group.waiters.push(resolve)
  })
  const commandWithTimeout = async (timeoutMs, name, ...args) => {
    if (closing || !client?.isReady || pending >= 1000) throw Object.assign(new Error('共享限流服務暫時不可用'), { status: 503 })
    pending++
    const startedAt = performance.now()
    let failed = false
    const controller = new AbortController()
    let timer
    const execute = lease => {
      if (controller.signal.aborted) throw Object.assign(new Error('共享限流服務命令逾時'), { status: 503 })
      return lease.withCommandOptions({ abortSignal: controller.signal })[name](...args)
    }
    // Bounded reusable leases avoid both the proxy's concurrent first-command
    // race and per-command use() command-interface construction.
    const operation = Promise.resolve().then(async () => {
      const lease = await commandClient()
      if (lease) return execute(lease)
      return sentinelMode && typeof client.use === 'function' ? client.use(execute) : execute(client)
    })
    operation.then(() => { pending-- }, () => { pending-- })
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('共享限流服務命令逾時'), { status: 503 })) }, timeoutMs) })
      ])
    } catch (error) {
      failed = true
      throw Object.assign(new Error(error?.message === '共享限流服務命令逾時' ? error.message : '共享限流服務暫時不可用'), { status: 503 })
    } finally {
      clearTimeout(timer)
      metrics.observe('s2t_redis_command_duration_seconds', { command: name }, (performance.now() - startedAt) / 1000, failed)
    }
  }
  const command = (name, ...args) => commandWithTimeout(sentinelMode ? 10000 : 3000, name, ...args)
  // An asynchronous primary switch can resurrect a lease whose ZREM was
  // acknowledged only by the former primary. Reconcile only our completed
  // operations against the current primary; never remove another live lease.
  const released = new Map()
  let reconciling = false
  const releaseCleanup = distributed && sentinelMode ? setInterval(async () => {
    if (closing || reconciling) return
    const now = Date.now()
    for (const [token, record] of released) if (record.expiresAt <= now) released.delete(token)
    if (!needsReconciliation || !client?.isReady) return
    const groups = new Map()
    for (const [token, record] of released) {
      if (!groups.has(record.key)) groups.set(record.key, [])
      groups.get(record.key).push(token)
    }
    reconciling = true; needsReconciliation = false
    try {
      for (const [key, tokens] of groups) for (let offset = 0; offset < tokens.length; offset += 512) {
        await command('zRem', key, tokens.slice(offset, offset + 512)).catch(() => { needsReconciliation = true })
      }
    } finally { reconciling = false }
  }, 1000) : null
  releaseCleanup?.unref()
  const windowBatch = sentinelMode && (typeof client?.acquire === 'function' || typeof client?.use === 'function') ? writer(entries => command('eval', WINDOW_BATCH, {
    keys: entries.map(entry => entry.key), arguments: entries.flatMap(entry => entry.args)
  })) : null
  const window = async (identity, bucket, maximum, duration, action) => {
    if (configurationError) throw configurationError
    if (!client?.isReady) throw new Error('共享限流服務暫時不可用')
    const digest = createHash('sha256').update(`${identity}:${bucket}`).digest('hex')
    const key = `s2t:limits:${digest}`, args = [String(duration), String(maximum), action, randomUUID()]
    const result = windowBatch ? await windowBatch.request({ key, args }) : await command('eval', WINDOW, { keys: [key], arguments: args })
    return { accepted: result[0] === 1, retryAfterSeconds: Number(result[1]), count: Number(result[2]) }
  }
  const localFailures = key => {
    const now = Date.now()
    for (const [k, times] of failures) if (!times.some(time => now - time < 900000)) failures.delete(k)
    const recent = (failures.get(key) || []).filter(time => now - time < 900000)
    failures.set(key, recent)
    return recent
  }
  return {
    ready, configurationError,
    stats: () => ({ pendingCommands: pending, waitingCapacity, releasingCapacity: releasing.size, admissionProbes: [...admissions.values()].reduce((sum, admission) => sum + admission.stats().probing, 0) }),
    async health() { if (distributed) { if (configurationError) throw configurationError; if (!client?.isReady) throw new Error('共享限流服務暫時不可用'); await commandWithTimeout(1000, 'ping') } },
    async accept(identity, bucket) { return distributed ? window(identity, bucket, limits[bucket] ?? 30, 60000, 'take') : local(identity, bucket) },
    async withCapacity(bucket, operation) {
      const admissionStart = performance.now()
      const setting = bucket === 'asr' ? 'S2T_ASR_MAX_INFLIGHT' : 'S2T_TRANSLATION_MAX_INFLIGHT'
      const configured = Number(env[setting] || (distributed ? 512 : 0))
      if (!Number.isSafeInteger(configured) || configured < 0 || (distributed && configured === 0)) throw new Error(`${setting} 必須為有效的正整數`)
      if (!configured) return operation() // Preserve standalone default behavior.
      const token = randomUUID(), key = `s2t:capacity:${bucket}`
      if (distributed) {
        if (waitingCapacity >= 1000) throw Object.assign(new Error('模型容量等待佇列已滿'), { status: 503 })
        waitingCapacity++
        try {
          if (sentinelMode) {
            if (!admissions.has(key)) admissions.set(key, createBatchAdmission({
              acquire: async (tokens, deadline) => {
                if (closing || !client?.isReady) throw Object.assign(new Error('協調服務不可用'), { status: 503 })
                return commandWithTimeout(Math.max(1, deadline - Date.now()), 'eval', ACQUIRE_BATCH, { keys: [key], arguments: [String(configured), ...tokens] })
              },
              abandon: async tokens => {
                for (const token of tokens) released.set(token, { key, expiresAt: Date.now() + 120000 })
                if (client?.isReady) await command('zRem', key, tokens).catch(() => { needsReconciliation = true })
              }
            }))
            await admissions.get(key).request(token)
          } else {
            const acquired = await command('eval', ACQUIRE, { keys: [key], arguments: [String(configured), token] })
            if (!acquired) throw Object.assign(new Error('模型併發容量已滿或協調服務不可用'), { status: 503 })
          }
        } finally { waitingCapacity-- }
      } else {
        if ((active.get(bucket) || 0) >= configured) throw Object.assign(new Error('模型併發容量已滿'), { status: 503 })
        active.set(bucket, (active.get(bucket) || 0) + 1)
      }
      metrics.observe('s2t_server_stage_duration_seconds', { stage: `${bucket}_capacity_wait` }, (performance.now() - admissionStart) / 1000)
      // Model calls have a <= 30s timeout; the lease also covers preprocessing.
      let lost = false
      const timer = distributed ? setInterval(() => {
        if (!client.isReady) { lost = true; return }
        command('eval', "local now = redis.call('TIME'); now = now[1]*1000 + math.floor(now[2]/1000); local score = redis.call('ZSCORE', KEYS[1], ARGV[1]); if not score or tonumber(score) <= now then return 0 end; redis.call('ZADD', KEYS[1], 'XX', now+120000, ARGV[1]); redis.call('PEXPIRE', KEYS[1], 120000); return 1", { keys: [key], arguments: [token] }).then(owned => { if (!owned) lost = true }).catch(() => { lost = true })
      }, 30000) : null
      timer?.unref()
      try { const result = await operation(); if (lost) throw Object.assign(new Error('模型容量租約失效'), { status: 503 }); return result }
      finally {
        if (timer) clearInterval(timer)
        if (distributed) {
          if (sentinelMode) {
            released.set(token, { key, expiresAt: Date.now() + 120000 })
            // Inference has finished. Releasing a throttle token is not a
            // durable result commit: do not delay the user's response behind
            // another Redis roundtrip. Until ZREM completes the token still
            // consumes capacity, so this cannot oversubscribe the model.
            const cleanup = releaseCapacity(key, token)
            releasing.add(cleanup); cleanup.then(() => releasing.delete(cleanup))
          } else await releaseCapacity(key, token)
        } else active.set(bucket, active.get(bucket) - 1)
      }
    },
    async loginAllowed(key) { return distributed ? window(key, 'login', 8, 900000, 'peek') : { accepted: localFailures(key).length < 8, retryAfterSeconds: 900 } },
    async loginFailed(key) { if (distributed) return window(key, 'login', 8, 900000, 'take'); const times = localFailures(key); times.push(Date.now()); return { count: times.length } },
    async loginSucceeded(key) { if (distributed) return window(key, 'login', 8, 900000, 'clear'); failures.delete(key) },
    async close() { await windowBatch?.close(); await Promise.all([...releases.keys()].map(flushRelease)); await Promise.all([...releasing]); closing = true; for (const admission of admissions.values()) admission.close(); if (releaseCleanup) clearInterval(releaseCleanup); released.clear(); clearTimeout(retryTimer); retryResolve?.(); if (sentinelMode) await ready.catch(() => undefined); if (commandLeases) { const leases = await commandLeases.catch(() => []); await Promise.allSettled(leases.map(lease => Promise.resolve().then(() => lease.release()))) } if (client?.isOpen) await Promise.resolve(client.destroy()).catch(() => undefined) }
  }
}
module.exports = { createSharedLimits, WINDOW, WINDOW_BATCH, ACQUIRE, ACQUIRE_BATCH }
