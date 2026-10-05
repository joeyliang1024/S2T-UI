const assert = require('node:assert/strict')
const { redisConnection } = require('../../server/redis-connection.cjs')
const { createSharedLimits } = require('../../server/shared-limits.cjs')
const env = { S2T_REDIS_SENTINEL_NODES: 'one:26379,two:26379,[::1]:26379', S2T_REDIS_SENTINEL_MASTER_NAME: 'mymaster', S2T_REDIS_SENTINEL_PASSWORD: 'sentinel-secret', S2T_REDIS_PASSWORD: 'data-secret', S2T_REDIS_SENTINEL_TLS: 'true', S2T_REDIS_TLS: 'false', S2T_REDIS_DATABASE: '2' }
const { options } = redisConnection(env)
assert.equal(options.sentinelRootNodes.length, 3)
assert.equal(options.sentinelRootNodes[2].host, '::1')
assert.equal(options.sentinelClientOptions.password, 'sentinel-secret')
assert.equal(options.nodeClientOptions.password, 'data-secret')
assert.equal(options.sentinelClientOptions.socket.tls, true)
assert.equal(options.nodeClientOptions.socket.tls, undefined)
assert.equal(options.nodeClientOptions.database, 2)
assert.equal(options.replicaPoolSize, 0)
assert.equal(options.maxCommandRediscovers, 16)
for (const change of [{ S2T_REDIS_URL: 'redis://localhost' }, { S2T_REDIS_SENTINEL_MASTER_NAME: '' }, { S2T_REDIS_SENTINEL_NODES: 'one:notport' }, { S2T_REDIS_SENTINEL_NODES: 'one:26379,' }, { S2T_REDIS_DATABASE: '-1' }, { S2T_REDIS_TLS: 'yes' }]) assert.throws(() => redisConnection({ ...env, ...change }))
assert.equal(redisConnection({ S2T_REDIS_URL: 'redis://localhost' }).mode, 'url')
assert.equal(createSharedLimits({ ...env, S2T_REDIS_SENTINEL_NODES: 'invalid' }, {}).configurationError, null) // Standalone ignores Sentinel settings.
console.log('PASS Sentinel configuration, separate auth/TLS, invalid groups, URL and standalone compatibility')

;(async () => {
 let signal
 const stalled = { isOpen: true, isReady: true, on() {}, destroy() {}, withCommandOptions(options) { signal = options.abortSignal; return { eval: () => new Promise(() => {}) } } }
 const limiter = createSharedLimits({ S2T_KUBERNETES_MODE: 'true', S2T_REDIS_URL: 'redis://localhost' }, {}, stalled)
 const start = Date.now()
 await assert.rejects(() => limiter.accept('timeout', 'asr'), /逾時/)
 assert.ok(Date.now() - start < 4500)
 assert.equal(signal.aborted, true)
 await limiter.close()
 console.log('PASS whole-command timeout and abort during topology waits')
 let acquireCalls = 0, models = 0, removals = 0
 const recovering = { isOpen: true, isReady: true, on() {}, destroy() {}, withCommandOptions() { return {
   eval: async () => ++acquireCalls === 1 ? 0 : 1,
   zRem: async () => { removals++; return 1 }
 } } }
 const sentinelLimits = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true', S2T_ASR_MAX_INFLIGHT: '1' }, {}, recovering)
 assert.equal(await sentinelLimits.withCapacity('asr', async () => { models++; return 'completed' }), 'completed')
 assert.equal(acquireCalls, 2)
 assert.equal(models, 1, 'capacity admission can wait, but must not retry model inference')
 await new Promise(resolve => setTimeout(resolve, 1100))
 assert.ok(removals >= 2, 'completed leases must be reconciled after a primary change')
 await sentinelLimits.close()
 const unavailable = { ...stalled, withCommandOptions(options) { signal = options.abortSignal; return { eval: () => new Promise(() => {}) } } }
 const failedSentinel = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true' }, {}, unavailable)
 const outageStart = Date.now()
 await assert.rejects(() => failedSentinel.accept('outage', 'asr'), /逾時/)
 assert.ok(Date.now() - outageStart >= 9500 && Date.now() - outageStart < 11500, 'Sentinel outage budget remains bounded')
 assert.equal(signal.aborted, true)
 await failedSentinel.close()
 const leases = new Set(), order = []
 const fifoClient = { isOpen: true, isReady: true, on() {}, destroy() {}, withCommandOptions() { return {
   eval: async (_script, args) => {
     const token = args.arguments[1]
     if (leases.has(token)) return 1
     if (leases.size) return 0
     leases.add(token); return 1
   },
   zRem: async (_key, tokens) => { for (const token of [tokens].flat()) leases.delete(token); return 1 }
 } } }
 const fifoLimits = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true', S2T_ASR_MAX_INFLIGHT: '1' }, {}, fifoClient)
 await Promise.all(Array.from({ length: 10 }, (_, i) => fifoLimits.withCapacity('asr', async () => {
   order.push(i); await new Promise(resolve => setTimeout(resolve, 30))
 })))
 assert.deepEqual(order, Array.from({ length: 10 }, (_, i) => i), 'capacity admission follows arrival order without serializing inference')
 assert.equal(leases.size, 0)
 await fifoLimits.close()
 const disconnected = { ...fifoClient, withCommandOptions() { return { eval: async () => { throw new Error('Socket closed unexpectedly') } } } }
 const failedCapacity = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true' }, {}, disconnected)
 await assert.rejects(failedCapacity.withCapacity('asr', async () => assert.fail('must not bypass failed coordination')), error => error.status === 503)
 await failedCapacity.close()
 console.log('PASS FIFO admission, bounded Sentinel failover wait, completed lease reconciliation and one model execution')
})().catch(error => { console.error(error); process.exitCode = 1 })
