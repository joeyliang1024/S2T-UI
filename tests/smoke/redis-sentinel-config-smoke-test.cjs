const assert = require('node:assert/strict')
const { redisConnection } = require('../../server/redis-connection.cjs')
const { createSharedLimits } = require('../../server/shared-limits.cjs')
const env = { REDIS_SENTINEL_NODES: 'one:26379,two:26379,[::1]:26379', REDIS_SERVICE_NAME: 'mymaster', REDIS_SENTINEL_PASSWARD: 'sentinel-secret', REDIS_PASSWARD: 'data-secret', REDIS_SENTINEL_TLS: 'true', REDIS_TLS: 'false', REDIS_DATABASE: '2' }
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
for (const change of [{ REDIS_URL: 'redis://localhost' }, { REDIS_SERVICE_NAME: '' }, { REDIS_SENTINEL_NODES: 'one:notport' }, { REDIS_SENTINEL_NODES: 'one:26379,' }, { REDIS_DATABASE: '-1' }, { REDIS_TLS: 'yes' }]) assert.throws(() => redisConnection({ ...env, ...change }))
assert.equal(redisConnection({ REDIS_URL: 'redis://localhost' }).mode, 'url')
assert.equal(createSharedLimits({ ...env, REDIS_SENTINEL_NODES: 'invalid' }, {}).configurationError, null) // Standalone ignores Sentinel settings.
assert.equal(redisConnection({ REDIS_SENTINEL_NODES: 'redis-node1,redis-node2:26380', REDIS_SERVICE_NAME: 'mymaster', REDIS_SENTINEL_USERNAME: 'default', REDIS_PASSWARD: 'node-secret', REDIS_SENTINEL_PASSWARD: 'sentinel-secret' }).options.sentinelRootNodes[0].port, 26379)
assert.throws(() => redisConnection({ S2T_REDIS_URL: 'redis://localhost' }))
assert.throws(() => redisConnection({ S2T_REDIS_SENTINEL_NODES: 'old:26379', S2T_REDIS_SENTINEL_MASTER_NAME: 'old' }))
const noAliases = redisConnection({ REDIS_SENTINEL_NODES: 'node', REDIS_SERVICE_NAME: 'mymaster', REDIS_PASSWORD: 'unsupported', REDIS_SENTINEL_PASSWORD: 'unsupported' }).options
assert.equal(noAliases.nodeClientOptions.password, undefined)
assert.equal(noAliases.sentinelClientOptions.password, undefined)
console.log('PASS new Sentinel names, separate auth/TLS, invalid groups, old names rejected and standalone mode')

;(async () => {
 let signal
 const stalled = { isOpen: true, isReady: true, on() {}, destroy() {}, withCommandOptions(options) { signal = options.abortSignal; return { eval: () => new Promise(() => {}) } } }
 const limiter = createSharedLimits({ S2T_KUBERNETES_MODE: 'true', REDIS_URL: 'redis://localhost' }, {}, stalled)
 const start = Date.now()
 await assert.rejects(() => limiter.accept('timeout', 'asr'), /逾時/)
 assert.ok(Date.now() - start < 4500)
 assert.equal(signal.aborted, true)
 await limiter.close()
 console.log('PASS whole-command timeout and abort during topology waits')
 const lifecycle = new Map()
 let acquireCalls = 0, models = 0, removals = 0
 const recovering = { isOpen: true, isReady: true, on(event,listener) { lifecycle.set(event,listener) }, destroy() {}, withCommandOptions() { return {
   eval: async (_script, args) => ++acquireCalls === 1 ? [] : args.arguments.slice(1),
   zRem: async () => { removals++; return 1 }
 } } }
 const sentinelLimits = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true', S2T_ASR_MAX_INFLIGHT: '1' }, {}, recovering)
 assert.equal(await sentinelLimits.withCapacity('asr', async () => { models++; return 'completed' }), 'completed')
 assert.equal(acquireCalls, 2)
 assert.equal(models, 1, 'capacity admission can wait, but must not retry model inference')
 lifecycle.get('topology-change')()
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
 let explicit = 0, bulkCommands = 0
 const scopedClient = { isOpen: true, isReady: true, on() {}, destroy() {},
   withCommandOptions() { assert.fail('Sentinel commands must use explicit scoped leases') },
   async use(operation) { explicit++; return operation({ withCommandOptions() { return { eval: async (script,args) => { bulkCommands++; assert.ok(script.includes('local function check')); return args.keys.map(() => [1,0,1]) }, ping: async () => 'PONG' } } }) }
 }
 const batched = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true' }, {}, scopedClient)
 const accepted = await Promise.all(Array.from({length:500},(_,i)=>batched.accept('bulk-'+i,'asr')))
 assert.ok(accepted.every(x=>x.accepted)); assert.equal(bulkCommands,4)
 await batched.health(); assert.equal(explicit,5)
 await batched.close()
 console.log('PASS 500 rate checks use four bounded atomic batches and explicit Sentinel leases')
 let acquiredObjects=0,releasedObjects=0,pooledCalls=0
 const reusableClient={isOpen:true,isReady:true,on(){},destroy(){},
   withCommandOptions(){assert.fail('proxy command path must not be used')},use(){assert.fail('per-command use() rebuilds the command interface')},
   async acquire(){acquiredObjects++;return{release(){releasedObjects++},withCommandOptions(){return{eval:async(_script,args)=>{pooledCalls++;return args.keys.map(()=>[1,0,1])},ping:async()=> 'PONG'}}}}
 }
 const reusable=createSharedLimits({...env,S2T_KUBERNETES_MODE:'true'},{},reusableClient)
 await Promise.all(Array.from({length:500},(_,i)=>reusable.accept('reused-'+i,'asr')))
 await Promise.all(Array.from({length:500},()=>reusable.health()))
 assert.equal(acquiredObjects,4,'all commands reuse exactly the configured lease budget')
 assert.equal(pooledCalls,4,'500 rate checks remain atomic bounded batches')
 await reusable.close();assert.equal(releasedObjects,4,'close returns every reserved lease once')
 console.log('PASS 1000 commands reuse four Sentinel interfaces without proxy races or per-command factory allocation')
 const leases = new Set(), order = []
 const fifoClient = { isOpen: true, isReady: true, on() {}, destroy() {}, withCommandOptions() { return {
   eval: async (_script, args) => {
     const granted = []
     for (const token of args.arguments.slice(1)) {
       if (leases.has(token)) { granted.push(token); continue }
       if (leases.size >= Number(args.arguments[0])) break
       leases.add(token); granted.push(token)
     }
     return granted
   },
   zRem: async (_key, tokens) => { for (const token of [tokens].flat()) leases.delete(token); return 1 }
 } } }
 const fifoLimits = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true', S2T_ASR_MAX_INFLIGHT: '1' }, {}, fifoClient)
 await Promise.all(Array.from({ length: 10 }, (_, i) => fifoLimits.withCapacity('asr', async () => {
   order.push(i); await new Promise(resolve => setTimeout(resolve, 30))
 })))
 assert.deepEqual(order, Array.from({ length: 10 }, (_, i) => i), 'capacity admission follows arrival order without serializing inference')
 await fifoLimits.close()
 assert.equal(leases.size, 0,'shutdown drains asynchronous completed-token releases')
 let finishRelease, releaseStarted
 const releaseBegan=new Promise(resolve=>{releaseStarted=resolve})
 const slowRelease={isOpen:true,isReady:true,on(){},destroy(){},withCommandOptions(){return{
   eval:async(_script,args)=>args.arguments.slice(1),
   zRem:async()=>{releaseStarted();await new Promise(resolve=>{finishRelease=resolve});return 1}
 }}}
 const background=createSharedLimits({...env,S2T_KUBERNETES_MODE:'true'}, {}, slowRelease)
 assert.equal(await background.withCapacity('asr',async()=> 'durable result'),'durable result','completed inference must not await a stalled throttle cleanup')
 await releaseBegan
 let closed=false
 const shutdown=background.close().then(()=>{closed=true})
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,false,'shutdown must await in-flight cleanup even after its batch left the queue')
 finishRelease();await shutdown
 const disconnected = { ...fifoClient, withCommandOptions() { return { eval: async () => { throw new Error('Socket closed unexpectedly') } } } }
 const failedCapacity = createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true' }, {}, disconnected)
 await assert.rejects(failedCapacity.withCapacity('asr', async () => assert.fail('must not bypass failed coordination')), error => error.status === 503)
 await failedCapacity.close()
 console.log('PASS FIFO admission, bounded Sentinel failover wait, completed lease reconciliation and one model execution')
})().catch(error => { console.error(error); process.exitCode = 1 })
