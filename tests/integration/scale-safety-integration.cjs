const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { PostgresConfigStore, MinioBlobStore } = require('../../server/storage/remote.cjs')
const { createSharedLimits } = require('../../server/shared-limits.cjs')
const { RecordingChunks } = require('../../server/recording-chunks.cjs')
const { executeIdempotent } = require('../../server/idempotency.cjs')
const { createClient } = require('redis')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  if (!process.env.S2T_TEST_POSTGRES_PASSWORD || !process.env.S2T_TEST_REDIS_URL) throw new Error('Use an isolated test database and Redis; see deployment guide')
  const config = { S2T_POSTGRES_HOST: process.env.S2T_TEST_POSTGRES_HOST || '127.0.0.1', S2T_POSTGRES_PORT: process.env.S2T_TEST_POSTGRES_PORT || '16439', S2T_POSTGRES_DB_NAME: process.env.S2T_TEST_POSTGRES_DB || 'postgres', S2T_POSTGRES_USER: process.env.S2T_TEST_POSTGRES_USER || 'postgres', S2T_POSTGRES_PASSWORD: process.env.S2T_TEST_POSTGRES_PASSWORD }
  const a = new PostgresConfigStore(config), b = new PostgresConfigStore(config)
  const run = randomUUID(), userId = `test-${run}`, jobId = `job-${run}`
  const redisA = createClient({ url: process.env.S2T_TEST_REDIS_URL, disableOfflineQueue: true }), redisB = createClient({ url: process.env.S2T_TEST_REDIS_URL, disableOfflineQueue: true })
  redisA.on('error', () => {}); redisB.on('error', () => {})
  await Promise.all([redisA.connect(), redisB.connect()])
  const env = { S2T_KUBERNETES_MODE: 'true', REDIS_URL: process.env.S2T_TEST_REDIS_URL, S2T_ASR_MAX_INFLIGHT: '1' }
  const limitA = createSharedLimits(env, { asr: 8 }, redisA), limitB = createSharedLimits(env, { asr: 8 }, redisB)
  try {
    await Promise.all([a.ready, b.ready])
    await a.pool.query('INSERT INTO s2t_users(id, username, password_hash, nt, department) VALUES($1,$1,$2,$1,$2)', [userId, 'test'])
    for (let index = 0; index < 20; index++) {
      const initialCas = await Promise.all([a.compareAndSwap(userId, `initial-cas-${index}`, 0, { version: 1, writer: 'a' }), b.compareAndSwap(userId, `initial-cas-${index}`, 0, { version: 1, writer: 'b' })])
      assert.equal(initialCas.filter(Boolean).length, 1, 'first config write has exactly one CAS winner')
      await a.pool.query('DELETE FROM s2t_glossaries WHERE user_id = $1', [userId])
      const writes = await Promise.all([a.putGlossary(userId, 'pod-a', 0), b.putGlossary(userId, 'pod-b', 0)])
      assert.equal(writes.filter(Boolean).length, 1, 'first glossary write has exactly one CAS winner')
      assert.equal(writes.find(Boolean).version, 1)
      assert.equal(await b.putGlossary(userId, 'stale', 0), null)
      assert.equal((await a.getGlossary(userId)).version, 1)
    }
    await a.put(userId, 'sessions', { version: 1, sessions: [] })
    const input = { id: jobId, userId, sessionId: run, audioKey: run, payload: { processingToken: 'intent-1' } }
    await a.enqueueDiarizationJob(input)
    const claims = await Promise.all([a.claimDiarizationJob('owner-a', jobId), b.claimDiarizationJob('owner-b', jobId)])
    assert.equal(claims.filter(Boolean).length, 1)
    const lease = claims.find(Boolean), owner = claims[0] ? 'owner-a' : 'owner-b'
    await b.enqueueDiarizationJob({ ...input, id: `duplicate-${run}` })
    assert.equal((await a.getDiarizationJob(userId, jobId)).state, 'running')
    assert.equal(await a.renewDiarizationJob(jobId, owner, lease.leaseGeneration), true)
    assert.equal(await b.commitDiarizationJob(jobId, owner, lease.leaseGeneration, userId, 0, { version: 2 }), 'conflict')
    const results = await Promise.all([a, b].map(store => store.commitDiarizationJob(jobId, owner, lease.leaseGeneration, userId, 1, { version: 2, sessions: [] })))
    assert.equal(results.filter(value => value === 'committed').length, 1)
    await a.enqueueDiarizationJob({ ...input, payload: { processingToken: 'intent-2' } })
    const old = await a.claimDiarizationJob('owner-a', jobId)
    await a.pool.query("UPDATE s2t_diarization_jobs SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1", [jobId])
    const replacement = await b.claimDiarizationJob('owner-b', jobId)
    assert.equal(await a.commitDiarizationJob(jobId, 'owner-a', old.leaseGeneration, userId, 2, { version: 3 }), 'lost')
    assert.equal(await b.commitDiarizationJob(jobId, 'owner-b', replacement.leaseGeneration, userId, 2, { version: 3, sessions: [] }), 'committed')
    const decisions = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? limitA : limitB).accept(run, 'asr')))
    assert.equal(decisions.filter(value => value.accepted).length, 8, 'replicas share one quota')
    for (let index = 0; index < 8; index++) await (index % 2 ? limitA : limitB).loginFailed(run)
    assert.equal((await limitB.loginAllowed(run)).accepted, false)
    await limitA.loginSucceeded(run)
    assert.equal((await limitB.loginAllowed(run)).accepted, true)
    const task = limitA.withCapacity('asr', () => delay(100))
    await delay(20)
    await assert.rejects(limitB.withCapacity('asr', async () => 1), error => error.status === 503)
    await task
    assert.equal(await limitB.withCapacity('asr', async () => 2), 2)
    let calls = 0
    const operation = async () => { calls++; await delay(100); return 'cached' }
    const first = executeIdempotent(a, userId, 'asr', run, 'hash', operation)
    await delay(20)
    await assert.rejects(executeIdempotent(b, userId, 'asr', run, 'hash', operation), error => error.status === 409)
    await first
    assert.equal(await executeIdempotent(b, userId, 'asr', run, 'hash', operation), 'cached'); assert.equal(calls, 1)
    // A lease expiring while waiting for the sessions row lock must also be rejected.
    await a.enqueueDiarizationJob({ ...input, payload: { processingToken: 'intent-3' } })
    const expiring = await a.claimDiarizationJob('owner-a', jobId)
    await a.pool.query("UPDATE s2t_diarization_jobs SET lease_until = clock_timestamp() + INTERVAL '200 milliseconds' WHERE id = $1", [jobId])
    const blocker = await b.pool.connect()
    await blocker.query('BEGIN'); await blocker.query("SELECT value FROM s2t_config_records WHERE scope = $1 AND record_key = 'sessions' FOR UPDATE", [userId])
    const blocked = a.commitDiarizationJob(jobId, 'owner-a', expiring.leaseGeneration, userId, 3, { version: 4 })
    await delay(400); await blocker.query('ROLLBACK'); blocker.release()
    assert.equal(await blocked, 'lost'); assert.equal((await a.get(userId, 'sessions')).version, 3)
    if (process.env.S2T_TEST_MINIO_ENDPOINT) {
      const blob = new MinioBlobStore({ S2T_MINIO_ENDPOINT: process.env.S2T_TEST_MINIO_ENDPOINT, S2T_MINIO_BUCKET: `scale-${run}`, S2T_MINIO_ACCESS_KEY: process.env.S2T_TEST_MINIO_ACCESS_KEY, S2T_MINIO_SECRET_KEY: process.env.S2T_TEST_MINIO_SECRET_KEY })
      await blob.ready
      const chunksA = new RecordingChunks({ config: a, blob }), chunksB = new RecordingChunks({ config: b, blob })
      try {
        const pcm = Buffer.from([1, 0, 2, 0])
        const ack = await chunksA.append(userId, 'remote-capture', 0, 0, 16000, pcm)
        assert.equal(ack.durable, true)
        assert.equal((await chunksB.status(userId, 'remote-capture')).persistedSamples, 2)
        await chunksB.append(userId, 'remote-capture', 1, 2, 16000, pcm)
        await chunksA.finish(userId, 'remote-capture', 2, 4)
        const stream = await blob.readStream(userId, 'audio/remote-capture')
        const pieces = []; for await (const piece of stream) pieces.push(piece)
        assert.deepEqual(Buffer.concat(pieces).subarray(44), Buffer.concat([pcm, pcm]))
        await chunksB.removeCompleted(userId, 'remote-capture')
        assert.equal(await chunksA.status(userId, 'remote-capture'), null)
        assert.equal(await blob.readStream(userId, 'audio/remote-capture'), null)
        console.log('PASS: real PostgreSQL + MinIO cross-adapter chunk ACK, streaming assembly/read and cleanup')
      } finally {
        for (const key of await blob.list(userId)) await blob.remove(userId, key)
        await blob.client.removeBucket(blob.bucket)
      }
    }
    redisA.destroy()
    await assert.rejects(limitA.accept(run, 'asr'), /不可用/)
    console.log('PASS: PostgreSQL concurrent claim/commit, duplicate intent, stale owner, lock-wait expiry, cross-replica Redis quotas/login/capacity, durable response dedup and coordinator outage')
  } finally {
    await a.pool.query('DELETE FROM s2t_config_records WHERE scope = $1', [userId]).catch(() => {})
    await a.pool.query('DELETE FROM s2t_users WHERE id = $1', [userId]).catch(() => {})
    await Promise.all([a.pool.end(), b.pool.end(), limitA.close(), limitB.close()])
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
