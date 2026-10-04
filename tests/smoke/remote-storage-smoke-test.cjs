const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { join } = require('node:path')
const { promisify } = require('node:util')
const dotenv = require('dotenv')
const { createStorage } = require('../../server/storage/index.cjs')

// This is deliberately separate from storage:smoke.  It verifies the real
// service clients, never the local fallback adapters.
dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })
const execFileAsync = promisify(execFile)
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const runCasWorker = async (scope, writer) => {
  const { stdout } = await execFileAsync(process.execPath, [join(__dirname, '../helpers/storage-cas-worker.cjs')], { cwd: join(__dirname, '..', '..'), env: { ...process.env, S2T_CAS_SCOPE: scope, S2T_CAS_WRITER: writer, S2T_LOG_LEVEL: 'silent' } })
  return JSON.parse(stdout)
}
const dropTemporaryCollection = async (storage) => {
  let lastError
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await storage.vector.request('collections/drop', { collectionName: storage.vector.collection })
      return
    } catch (error) { lastError = error; await delay(500 * (attempt + 1)) }
  }
  throw lastError
}

const main = async () => {
  const runId = `remote-smoke-${randomUUID()}`
  const storage = createStorage({ ...process.env, S2T_MILVUS_COLLECTION: `${String(process.env.S2T_MILVUS_COLLECTION).replace(/[^A-Za-z0-9_]/g, '_')}_smoke_${runId.slice(-12).replace(/-/g, '')}` })
  const scope = `smoke-${runId}`
  const userId = `user-${runId}`
  const configKey = `record-${runId}`
  const blobKey = `audio/${runId}.bin`
  const vectorId = `vector-${runId}`
  const jobId = `job-${runId}`

  assert.deepEqual(storage.mode, { blob: 'minio', config: 'postgres', vector: 'milvus' }, 'remote smoke test requires all three external adapters')
  try {
    await storage.ready
    await storage.config.pool.query('INSERT INTO s2t_users(id, username, password_hash, nt, department) VALUES($1, $2, $3, $4, $5)', [userId, `remote-${runId}`, 'not-a-login', `REMOTE-${runId}`, 'Storage smoke'])

    await storage.config.put(scope, configKey, { runId, source: 'remote-smoke' })
    assert.deepEqual(await storage.config.get(scope, configKey), { runId, source: 'remote-smoke' })
    assert.equal(await storage.config.compareAndSwap(scope, 'sessions', 0, { version: 1, sessions: [{ id: runId }] }), true)
    assert.equal(await storage.config.compareAndSwap(scope, 'sessions', 0, { version: 2, sessions: [] }), false)
    const casScope = `cas-${runId}`
    const casResults = await Promise.all([runCasWorker(casScope, 'one'), runCasWorker(casScope, 'two')])
    assert.equal(casResults.filter((result) => result.won).length, 1, 'two processes must not both win the same CAS')
    assert.equal((await storage.config.get(casScope, 'cross-process-cas')).version, 1)
    await storage.config.remove(casScope, 'cross-process-cas')

    // Atomic read-modify-write: concurrent appenders must all land on the
    // shared list record instead of overwriting each other.
    await Promise.all(Array.from({ length: 24 }, (_, index) => storage.config.update(scope, 'queue', (value) => [...(Array.isArray(value) ? value : []), { index }])))
    const queue = await storage.config.get(scope, 'queue')
    assert.equal(queue.length, 24, 'every concurrent postgres update must be applied')
    assert.equal((await storage.config.update(scope, 'queue', () => undefined)).changed, false, 'an aborted transform must not write')
    await storage.config.remove(scope, 'queue')

    const job = await storage.config.enqueueDiarizationJob({ id: jobId, userId, sessionId: runId, audioKey: runId, payload: { user: { id: userId } } })
    assert.equal(job.state, 'queued')
    const claimed = await storage.config.claimDiarizationJob(`smoke-worker-${runId}`, jobId)
    assert.equal(claimed?.id, jobId)
    assert.deepEqual(claimed?.payload, { user: { id: userId } })
    assert.equal(await storage.config.stillOwnsDiarizationJob(jobId, `smoke-worker-${runId}`, claimed?.leaseGeneration), true)
    assert.equal(await storage.config.renewDiarizationJob(jobId, `smoke-worker-${runId}`, claimed?.leaseGeneration), true)
    assert.equal(await storage.config.renewDiarizationJob(jobId, `other-worker-${runId}`, claimed?.leaseGeneration), false)
    await storage.config.finishDiarizationJob(jobId, `smoke-worker-${runId}`, claimed?.leaseGeneration)
    assert.equal((await storage.config.getDiarizationJob(userId, jobId))?.state, 'completed')

    const fencedJobId = `${jobId}-fenced`
    await storage.config.enqueueDiarizationJob({ id: fencedJobId, userId, sessionId: `${runId}-fenced`, audioKey: `${runId}-fenced`, payload: { user: { id: userId } } })
    const firstLease = await storage.config.claimDiarizationJob(`stale-worker-${runId}`, fencedJobId)
    await storage.config.pool.query("UPDATE s2t_diarization_jobs SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1", [fencedJobId])
    assert.equal(await storage.config.renewDiarizationJob(fencedJobId, `stale-worker-${runId}`, firstLease?.leaseGeneration), false)
    const replacementLease = await storage.config.claimDiarizationJob(`replacement-worker-${runId}`, fencedJobId)
    assert.equal(await storage.config.stillOwnsDiarizationJob(fencedJobId, `stale-worker-${runId}`, firstLease?.leaseGeneration), false)
    await storage.config.finishDiarizationJob(fencedJobId, `stale-worker-${runId}`, firstLease?.leaseGeneration)
    assert.equal((await storage.config.getDiarizationJob(userId, fencedJobId))?.state, 'running')
    await storage.config.finishDiarizationJob(fencedJobId, `replacement-worker-${runId}`, replacementLease?.leaseGeneration)
    assert.equal((await storage.config.getDiarizationJob(userId, fencedJobId))?.state, 'completed')

    // A job requeued with retry: must wait behind a growing backoff lease
    // instead of being claimed again on the next two-second drain.
    const retryJobId = `${jobId}-retry`
    await storage.config.enqueueDiarizationJob({ id: retryJobId, userId, sessionId: `${runId}-retry`, audioKey: `${runId}-retry`, payload: { user: { id: userId } } })
    const retryLease = await storage.config.claimDiarizationJob(`retry-worker-${runId}`, retryJobId)
    assert.equal(retryLease?.id, retryJobId)
    await storage.config.finishDiarizationJob(retryJobId, `retry-worker-${runId}`, retryLease?.leaseGeneration, 'retry:紀錄尚未同步完成')
    assert.equal((await storage.config.getDiarizationJob(userId, retryJobId))?.state, 'queued')
    assert.equal(await storage.config.claimDiarizationJob(`retry-worker-${runId}`, retryJobId), null, 'a retried job must wait behind its backoff lease')
    await storage.config.pool.query('UPDATE s2t_diarization_jobs SET lease_until = NULL WHERE id = $1', [retryJobId])
    const retryReclaim = await storage.config.claimDiarizationJob(`retry-worker-${runId}`, retryJobId)
    assert.equal(retryReclaim?.id, retryJobId, 'the job must be claimable again once the backoff lease expires')
    await storage.config.finishDiarizationJob(retryJobId, `retry-worker-${runId}`, retryReclaim?.leaseGeneration)
    assert.equal((await storage.config.getDiarizationJob(userId, retryJobId))?.state, 'completed')

    const bytes = Buffer.from(`remote storage smoke ${runId}`)
    await storage.blob.put(scope, blobKey, bytes)
    assert.deepEqual(await storage.blob.get(scope, blobKey), bytes)
    assert.deepEqual(await storage.blob.list(scope, 'audio'), [blobKey])

    const embedding = [1, 0, 0, 0]
    await storage.vector.upsert({ id: vectorId, NT: `Smoke ${runId}`, Department: 'Storage smoke', embedding })
    const nearest = await storage.vector.nearest(embedding, 1, [vectorId])
    assert.equal(nearest[0]?.id, vectorId)
    assert.equal(nearest[0]?.NT, `Smoke ${runId}`)
    console.log('Remote storage smoke test passed.')
  } finally {
    await Promise.allSettled([
      storage.blob.remove(scope, blobKey),
      storage.config.remove(scope, configKey),
      storage.config.remove(scope, 'sessions'),
      storage.config.removeDiarizationJob?.(userId, jobId),
      storage.config.removeDiarizationJob?.(userId, `${jobId}-fenced`),
      storage.config.removeDiarizationJob?.(userId, `${jobId}-retry`),
      storage.config.pool?.query('DELETE FROM s2t_users WHERE id = $1', [userId]),
      storage.vector.remove(vectorId)
    ])
    await dropTemporaryCollection(storage)
    await storage.config.pool?.end()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
