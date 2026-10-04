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
})().catch(error => { console.error(error); process.exitCode = 1 })
