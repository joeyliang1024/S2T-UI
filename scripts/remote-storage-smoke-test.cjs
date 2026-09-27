const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { join } = require('node:path')
const { promisify } = require('node:util')
const dotenv = require('dotenv')
const { createStorage } = require('../server/storage/index.cjs')

// This is deliberately separate from storage:smoke.  It verifies the real
// service clients, never the local fallback adapters.
dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })
const execFileAsync = promisify(execFile)
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const runCasWorker = async (scope, writer) => {
  const { stdout } = await execFileAsync(process.execPath, [join(__dirname, 'storage-cas-worker.cjs')], { cwd: join(__dirname, '..'), env: { ...process.env, S2T_CAS_SCOPE: scope, S2T_CAS_WRITER: writer } })
  return JSON.parse(stdout)
}
const dropTemporaryCollection = async (storage) => {
  let lastError
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await storage.vector.client.dropCollection({ collection_name: storage.vector.collection, db_name: storage.vector.database })
      return
    } catch (error) { lastError = error; await delay(500 * (attempt + 1)) }
  }
  throw lastError
}

const main = async () => {
  const runId = `remote-smoke-${randomUUID()}`
  const storage = createStorage({ ...process.env, S2T_MILVUS_COLLECTION: `${String(process.env.S2T_MILVUS_COLLECTION).replace(/[^A-Za-z0-9_]/g, '_')}_smoke_${runId.slice(-12).replace(/-/g, '')}` })
  const scope = `smoke-${runId}`
  const configKey = `record-${runId}`
  const blobKey = `audio/${runId}.bin`
  const vectorId = `vector-${runId}`

  assert.deepEqual(storage.mode, { blob: 'minio', config: 'postgres', vector: 'milvus' }, 'remote smoke test requires all three external adapters')
  try {
    await storage.ready

    await storage.config.put(scope, configKey, { runId, source: 'remote-smoke' })
    assert.deepEqual(await storage.config.get(scope, configKey), { runId, source: 'remote-smoke' })
    assert.equal(await storage.config.compareAndSwap(scope, 'sessions', 0, { version: 1, sessions: [{ id: runId }] }), true)
    assert.equal(await storage.config.compareAndSwap(scope, 'sessions', 0, { version: 2, sessions: [] }), false)
    const casScope = `cas-${runId}`
    const casResults = await Promise.all([runCasWorker(casScope, 'one'), runCasWorker(casScope, 'two')])
    assert.equal(casResults.filter((result) => result.won).length, 1, 'two processes must not both win the same CAS')
    assert.equal((await storage.config.get(casScope, 'cross-process-cas')).version, 1)
    await storage.config.remove(casScope, 'cross-process-cas')

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
      storage.vector.remove(vectorId)
    ])
    await dropTemporaryCollection(storage)
    await storage.config.pool?.end()
    await storage.vector.client?.closeConnection?.()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
