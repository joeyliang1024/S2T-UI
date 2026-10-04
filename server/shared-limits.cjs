const { createHash, randomUUID } = require('node:crypto')
const { createRequestLimiter } = require('./request-limits.cjs')

// One atomic sliding-window operation, matching the standalone limiter's semantics.
const WINDOW = `
local now = redis.call('TIME'); now = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[1]))
local count = redis.call('ZCARD', KEYS[1])
if ARGV[3] == 'clear' then redis.call('DEL', KEYS[1]); return {1, 0, 0} end
if count >= tonumber(ARGV[2]) then
 local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
 return {0, math.max(1, math.ceil((tonumber(oldest[2]) + tonumber(ARGV[1]) - now) / 1000)), count}
end
if ARGV[3] == 'take' then
 redis.call('ZADD', KEYS[1], now, ARGV[4]); redis.call('PEXPIRE', KEYS[1], ARGV[1]); count = count + 1
end
return {1, 0, count}`

const ACQUIRE = `
local now = redis.call('TIME'); now = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + 120000, ARGV[2]); redis.call('PEXPIRE', KEYS[1], 120000); return 1`

const createSharedLimits = (env, limits, suppliedClient) => {
  const distributed = env.S2T_KUBERNETES_MODE === 'true'
  const local = createRequestLimiter(limits)
  const failures = new Map()
  const active = new Map()
  let client = suppliedClient
  let configurationError = null
  let ready = Promise.resolve()
  if (distributed) {
    if (!env.S2T_REDIS_URL) configurationError = new Error('Kubernetes 模式必須設定 S2T_REDIS_URL')
    else {
      try {
        client ||= require('redis').createClient({ url: env.S2T_REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 1000, socket: { connectTimeout: 3000, reconnectStrategy: retries => Math.min(2000, 100 * (retries + 1)) } })
        client.on('error', () => undefined) // Never log connection URLs containing credentials.
        ready = client.isOpen ? Promise.resolve() : client.connect()
      } catch { configurationError = new Error('Redis 設定無效') }
    }
    if (configurationError) ready = Promise.reject(configurationError)
  }
  ready.catch(() => undefined)
  const window = async (identity, bucket, maximum, duration, action) => {
    if (configurationError) throw configurationError
    if (!client?.isReady) throw new Error('共享限流服務暫時不可用')
    const digest = createHash('sha256').update(`${identity}:${bucket}`).digest('hex')
    const result = await client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).eval(WINDOW, { keys: [`s2t:limits:${digest}`], arguments: [String(duration), String(maximum), action, randomUUID()] })
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
    async health() { if (distributed) { if (configurationError) throw configurationError; if (!client?.isReady) throw new Error('共享限流服務暫時不可用'); await client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).ping() } },
    async accept(identity, bucket) { return distributed ? window(identity, bucket, limits[bucket] ?? 30, 60000, 'take') : local(identity, bucket) },
    async withCapacity(bucket, operation) {
      const setting = bucket === 'asr' ? 'S2T_ASR_MAX_INFLIGHT' : 'S2T_TRANSLATION_MAX_INFLIGHT'
      const configured = Number(env[setting] || (distributed ? 64 : 0))
      if (!Number.isSafeInteger(configured) || configured < 0 || (distributed && configured === 0)) throw new Error(`${setting} 必須為有效的正整數`)
      if (!configured) return operation() // Preserve standalone default behavior.
      const token = randomUUID(), key = `s2t:capacity:${bucket}`
      if (distributed) {
        if (!client?.isReady || !await client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).eval(ACQUIRE, { keys: [key], arguments: [String(configured), token] })) throw Object.assign(new Error('模型併發容量已滿或協調服務不可用'), { status: 503 })
      } else {
        if ((active.get(bucket) || 0) >= configured) throw Object.assign(new Error('模型併發容量已滿'), { status: 503 })
        active.set(bucket, (active.get(bucket) || 0) + 1)
      }
      // Model calls have a <= 30s timeout; the lease also covers preprocessing.
      let lost = false
      const timer = distributed ? setInterval(() => {
        if (!client.isReady) { lost = true; return }
        client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).eval("local now = redis.call('TIME'); now = now[1]*1000 + math.floor(now[2]/1000); local score = redis.call('ZSCORE', KEYS[1], ARGV[1]); if not score or tonumber(score) <= now then return 0 end; redis.call('ZADD', KEYS[1], 'XX', now+120000, ARGV[1]); redis.call('PEXPIRE', KEYS[1], 120000); return 1", { keys: [key], arguments: [token] }).then(owned => { if (!owned) lost = true }).catch(() => { lost = true })
      }, 30000) : null
      timer?.unref()
      try { const result = await operation(); if (lost) throw Object.assign(new Error('模型容量租約失效'), { status: 503 }); return result }
      finally { if (timer) clearInterval(timer); if (distributed) { if (client.isReady) await client.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).zRem(key, token).catch(() => undefined) } else active.set(bucket, active.get(bucket) - 1) }
    },
    async loginAllowed(key) { return distributed ? window(key, 'login', 8, 900000, 'peek') : { accepted: localFailures(key).length < 8, retryAfterSeconds: 900 } },
    async loginFailed(key) { if (distributed) return window(key, 'login', 8, 900000, 'take'); const times = localFailures(key); times.push(Date.now()); return { count: times.length } },
    async loginSucceeded(key) { if (distributed) return window(key, 'login', 8, 900000, 'clear'); failures.delete(key) },
    async close() { if (client?.isOpen) client.destroy() }
  }
}
module.exports = { createSharedLimits, WINDOW }
