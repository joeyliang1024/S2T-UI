const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createSentinel } = require('/app/node_modules/redis')
const { redisConnection } = require('/app/server/redis-connection.cjs')
const { WINDOW, ACQUIRE } = require('/app/server/shared-limits.cjs')
;(async () => {
 const client = createSentinel(redisConnection(process.env).options)
 client.on('error', () => {})
 await client.connect()
 const root = 's2t:test:replay:' + randomUUID(), keys = [root + ':window', root + ':capacity']
 try {
  const window = () => client.eval(WINDOW, { keys: [keys[0]], arguments: ['60000', '1', 'take', 'same-request'] })
  const results = await Promise.all(Array.from({ length: 20 }, window))
  assert.ok(results.every(r => r[0] === 1 && r[2] === 1))
  assert.equal(await client.zCard(keys[0]), 1)
  assert.equal((await client.eval(WINDOW, {keys:[keys[0]],arguments:['60000','1','take','different-request']}))[0], 0)
  const leases = await Promise.all(Array.from({ length: 20 }, () => client.eval(ACQUIRE,{keys:[keys[1]],arguments:['1','same-lease']})))
  assert.ok(leases.every(r => r === 1))
  assert.equal(await client.zCard(keys[1]), 1)
  assert.equal(await client.eval(ACQUIRE,{keys:[keys[1]],arguments:['1','different-lease']}), 0)
  console.log(JSON.stringify({passed:true,duplicateWindowCommands:20,windowCount:1,duplicateCapacityCommands:20,capacityCount:1,differentRequestsRejected:true}))
 } finally { await client.del(keys); await client.destroy() }
})().catch(e => { console.error(e); process.exitCode=1 })
