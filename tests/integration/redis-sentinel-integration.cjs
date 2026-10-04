// Run against a dedicated Redis primary + 2 replicas and 3 password-protected Sentinels.
// Sentinel seed 0 is deliberately unavailable; fixture names are isolated test resources.
const assert = require('node:assert/strict')
const { createClient } = require('redis')
const { createSharedLimits } = require('../../server/shared-limits.cjs')
const { setTimeout: delay } = require('node:timers/promises')
const env = { S2T_KUBERNETES_MODE: 'true', S2T_REDIS_SENTINEL_NODES: 's2t-sentinel-check-s0:26379,s2t-sentinel-check-s1:26379,s2t-sentinel-check-s2:26379', S2T_REDIS_SENTINEL_MASTER_NAME: 'testmaster', S2T_REDIS_SENTINEL_PASSWORD: 'sentinel-test-password', S2T_REDIS_PASSWORD: 'redis-test-password' }
const until = async (fn, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await fn()) return } catch {} await delay(200) } throw new Error('Timed out awaiting Sentinel recovery') }
;(async () => {
 const a = createSharedLimits(env, { asr: 2 }), b = createSharedLimits(env, { asr: 2 })
 const sentinel = createClient({ url: 'redis://:sentinel-test-password@s2t-sentinel-check-s1:26379', socket: { connectTimeout: 1000 }, disableOfflineQueue: true })
 sentinel.on('error', () => {})
 try {
  await until(async () => { await a.health(); await b.health(); return true })
  assert.equal((await a.accept('account-before', 'asr')).accepted, true)
  assert.equal((await b.accept('account-before', 'asr')).accepted, true)
  assert.equal((await a.accept('account-before', 'asr')).accepted, false)
  for (const key of ['S2T_REDIS_SENTINEL_PASSWORD', 'S2T_REDIS_PASSWORD']) {
   const invalid = createSharedLimits({ ...env, [key]: 'wrong-password' }, { asr: 2 })
   try { await delay(1500); await assert.rejects(() => invalid.health()) } finally { await invalid.close() }
  }
  await sentinel.connect()
  const master = () => sentinel.sendCommand(['SENTINEL', 'get-master-addr-by-name', 'testmaster'])
  const before = await master()
  await sentinel.sendCommand(['SENTINEL', 'FAILOVER', 'testmaster'])
  await until(async () => JSON.stringify(await master()) !== JSON.stringify(before))
  await until(async () => { await a.health(); return (await a.accept('after-' + Date.now(), 'asr')).accepted })
  await b.health()
  console.log('PASS three seeds with one unavailable, independent Sentinel/Redis passwords, shared quotas and real primary promotion recovery')
 } finally { await a.close(); await b.close(); if (sentinel.isOpen) sentinel.destroy() }
})().catch(error => { console.error(error); process.exitCode = 1 })
