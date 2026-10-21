const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { PostgresConfigStore } = require('/app/server/storage/remote.cjs')
const { PostgresAccountFence } = require('/app/server/storage/account-fence.cjs')
const { executeIdempotent } = require('/app/server/idempotency.cjs')
const { Pool } = require('pg')
const id = 'invariant-' + randomUUID(), key = 'request-invariant'
const config = { S2T_POSTGRES_HOST: 'postgres', S2T_POSTGRES_PORT: '5432', S2T_POSTGRES_DB_NAME: 's2t', S2T_POSTGRES_USER: 's2t', S2T_POSTGRES_PASSWORD: process.env.PG_TEST_PASSWORD, S2T_POSTGRES_MAX_CONNECTIONS: '1', S2T_STORAGE_MIGRATIONS: 'verify' }
const store = new PostgresConfigStore(config)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
;(async () => {
  await store.ready
  const cleanupClient = await store.pool.connect()
  try {
    await cleanupClient.query('BEGIN')
    // Temporary shadow table: cleanup regression cannot touch account data.
    await cleanupClient.query('CREATE TEMP TABLE s2t_config_records(scope text,record_key text,value jsonb,PRIMARY KEY(scope,record_key)) ON COMMIT DROP')
    await cleanupClient.query(`INSERT INTO s2t_config_records SELECT 'test','request-' || lpad(to_hex(n),64,'0'),'{"expiresAt":0}'::jsonb FROM generate_series(1,2050) n`)
    await cleanupClient.query(`INSERT INTO s2t_config_records VALUES ('test','recording-keep','{"expiresAt":0}'),('test','request-' || repeat('f',64),jsonb_build_object('expiresAt',$1::bigint)),('test','request-' || repeat('e',64),'{"expiresAt":"invalid"}')`,[Date.now()+600000])
    const pruner = Object.assign(Object.create(PostgresConfigStore.prototype), { ready:Promise.resolve(),pool:cleanupClient })
    let removed=0
    for(let i=0;i<5;i++){const count=await pruner.pruneExpiredRequests();assert.ok(count<=1024);removed+=count}
    assert.equal(removed,2050,'bounded pages eventually remove every expired request')
    assert.equal((await cleanupClient.query('SELECT count(*)::int AS n FROM s2t_config_records')).rows[0].n,3,'retain live requests, malformed expiry and non-request data')
    console.log('PASS bounded PG cleanup: paginated expiry, wraparound, live/non-request/malformed records preserved')
  } finally { await cleanupClient.query('ROLLBACK');cleanupClient.release() }
  await store.pool.query(`INSERT INTO s2t_users(id,username,password_hash,nt,department,role) VALUES($1,$1,'no-login',$1,'invariant','user')`, [id])
  await Promise.all(Array.from({length:500},(_,index)=>store.putCheckpoint(id,'live-draft',{index})))
  assert.equal((await store.get(id,'live-draft')).index,499,'checkpoint batches retain the last concurrent snapshot with pool max=1')
  let calls = 0
  const invoke = (fingerprint = 'fingerprint') => executeIdempotent(store, id, '/test', 'request-one', fingerprint, async () => { calls++; return 'cached result' })
  assert.equal(await invoke(), 'cached result'); assert.equal(await invoke(), 'cached result'); assert.equal(calls, 1)
  await assert.rejects(invoke('different'), { status: 409 })
  const old = { fingerprint: 'same', owner: 'old', state: 'running', leaseUntil: Date.now() - 1, expiresAt: Date.now() + 600000 }
  await store.claimRequest(id, key, old)
  const current = { ...old, owner: 'current', leaseUntil: Date.now() + 120000 }
  assert.equal((await store.claimRequest(id, key, current)).owner, 'current')
  assert.equal(await store.completeRequest(id, key, 'old', { result: 'unsafe' }), false)
  assert.equal(await store.completeRequest(id, key, 'current', { result: 'safe' }), true)
  await store.updateRecording(id, 'recording-empty-test', () => undefined)
  assert.equal((await store.pool.query('SELECT 1 FROM s2t_config_records WHERE scope=$1 AND record_key=$2',[id,'recording-empty-test'])).rowCount,0,'no-op must not leave placeholder records')
  const updates = await Promise.all(Array.from({length: 500}, () => store.updateRecording(id, 'recording-batch-test', value => ({ count: (value?.count || 0) + 1 }))))
  assert.equal(updates.length, 500)
  assert.equal((await store.get(id, 'recording-batch-test')).count, 500)
  const mixed = await Promise.allSettled([
    store.updateRecording(id, 'recording-batch-test', value => { value.count = -100; throw new Error('expected isolated transform failure') }),
    store.updateRecording(id, 'recording-batch-test', value => ({ count: value.count + 1 }))
  ])
  assert.equal(mixed[0].status, 'rejected'); assert.equal(mixed[1].status, 'fulfilled')
  assert.equal((await store.get(id, 'recording-batch-test')).count, 501)
  const fencePool = new Pool({ ...store.pool.options, password: config.S2T_POSTGRES_PASSWORD, max: 2 })
  const fence = new PostgresAccountFence(fencePool, (userId, client) => store.getUserState(userId, client), { batch: true })
  try {
    const writes = await Promise.all(Array.from({ length: 500 }, () => fence.withWrite(id, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return true })))
    assert.equal(writes.length, 500); assert.equal(fence.readers.size, 0)
    assert.equal(await fence.withWrite(id, async () => 'before disconnect'), 'before disconnect')
    const pid = (await fence.shared.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await store.pool.query('SELECT pg_terminate_backend($1)', [pid])
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await fence.withWrite(id, async () => 'recovered'), 'recovered')
  } finally { await fence.close(); await fencePool.end() }
  const began = deferred(), finish = deferred()
  const pending = executeIdempotent(store, id, '/test', 'delete-race', 'same', async () => { began.resolve(); await finish.promise; return 'must not recreate data' })
  await began.promise
  await store.pool.query("UPDATE s2t_users SET deletion_state = 'deleting' WHERE id = $1", [id])
  await store.pool.query('DELETE FROM s2t_config_records WHERE scope = $1', [id])
  finish.resolve(); await assert.rejects(pending, { status: 503 })
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM s2t_config_records WHERE scope = $1', [id])).rows[0].n, 0)
  await assert.rejects(store.claimRequest(id, key, current), { code: 'ACCOUNT_DELETING' })
  await assert.rejects(store.putCheckpoint(id,'live-draft',{}), { code:'ACCOUNT_DELETING' })
  console.log('PASS real PostgreSQL: cached/conflicting retries, stale lease replacement, pool max=1, backend disconnect/reconnect and no record resurrection after deletion')
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  await store.pool.query('DELETE FROM s2t_config_records WHERE scope = $1', [id]).catch(() => {})
  await store.pool.query('DELETE FROM s2t_users WHERE id = $1', [id]).catch(() => {})
  await store.close()
})
