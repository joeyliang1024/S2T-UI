const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { promisify } = require('node:util')
const dotenv = require('dotenv')
const { createStorage } = require('../../server/storage/index.cjs')
const { snapshotVoiceprints, restoreVoiceprints } = require('../../server/storage/voiceprint-backup.cjs')

dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })
const execFileAsync = promisify(execFile)

const main = async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const userId = `backup-${suffix}`
  const vectorId = `backup-vp-${suffix}`
  const storage = createStorage({ ...process.env, S2T_MILVUS_COLLECTION: `${String(process.env.S2T_MILVUS_COLLECTION).replace(/[^A-Za-z0-9_]/g, '_')}_backup_${suffix}` })
  try {
    assert.deepEqual(storage.mode, { blob: 'minio', config: 'postgres', vector: 'milvus' }, 'backup smoke requires the three external adapters')
    await storage.ready
    await storage.config.pool.query('INSERT INTO s2t_users(id, username, password_hash, nt, department) VALUES($1, $2, $3, $4, $5)', [userId, `backup${suffix}`, 'not-a-login', `BACKUP-${suffix}`, 'Storage smoke'])
    const record = { id: vectorId, NT: `BACKUP-${suffix}`, Department: 'Storage smoke', embedding: [1, 0, 0, 0] }
    const entry = { id: vectorId, NT: record.NT, Department: record.Department, dimensions: 4, embeddingModel: 'backup-smoke', embeddingVersion: 'v1', sharingScope: 'private', createdAt: new Date().toISOString() }
    await storage.vector.upsert(record)
    await storage.config.createVoiceprint({ vectorId, userId, embeddingModel: entry.embeddingModel, embeddingVersion: entry.embeddingVersion, sharingScope: entry.sharingScope })
    await storage.config.put(userId, 'voiceprints', [entry])

    const snapshot = await snapshotVoiceprints(storage, userId)
    assert.equal(snapshot.vectors[0]?.id, vectorId)
    assert.equal(snapshot.metadata[0]?.vectorId, vectorId)
    await storage.vector.remove(vectorId)
    await storage.config.replaceVoiceprints(userId, [])
    await storage.config.put(userId, 'voiceprints', [])

    const originalPut = storage.config.put.bind(storage.config)
    let injectFailure = true
    storage.config.put = async (...args) => {
      if (injectFailure && args[0] === userId && args[1] === 'voiceprints') { injectFailure = false; throw new Error('injected settings write failure') }
      return originalPut(...args)
    }
    await assert.rejects(() => restoreVoiceprints(storage, snapshot), /injected settings write failure/)
    storage.config.put = originalPut
    assert.deepEqual(await storage.config.get(userId, 'voiceprints'), [])
    assert.deepEqual(await storage.config.listVoiceprints(userId), [])
    assert.deepEqual(await storage.vector.getMany([vectorId]), [])

    await restoreVoiceprints(storage, snapshot)
    assert.deepEqual(await storage.config.get(userId, 'voiceprints'), [entry])
    assert.equal((await storage.config.listVoiceprints(userId))[0]?.vectorId, vectorId)
    assert.deepEqual((await storage.vector.getMany([vectorId]))[0], record)

    const workDirectory = await mkdtemp(join(tmpdir(), 's2t-voiceprint-restore-'))
    const snapshotPath = join(workDirectory, 'snapshot.json')
    try {
      await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o600 })
      await storage.vector.remove(vectorId)
      await storage.config.replaceVoiceprints(userId, [])
      await storage.config.put(userId, 'voiceprints', [])
      const worker = () => execFileAsync(process.execPath, [join(__dirname, '../helpers/storage-voiceprint-restore-worker.cjs'), snapshotPath], { cwd: join(__dirname, '..', '..'), env: { ...process.env, S2T_MILVUS_COLLECTION: storage.vector.collection } })
      await Promise.all([worker(), worker()])
      assert.deepEqual(await storage.config.get(userId, 'voiceprints'), [entry])
      assert.equal((await storage.config.listVoiceprints(userId))[0]?.vectorId, vectorId)
      assert.deepEqual((await storage.vector.getMany([vectorId]))[0], record)
    } finally { await rm(workDirectory, { recursive: true, force: true }) }
    console.log('External voiceprint backup/restore smoke test passed.')
  } finally {
    await Promise.allSettled([
      storage.vector.remove(vectorId),
      storage.config.replaceVoiceprints?.(userId, []),
      storage.config.remove(userId, 'voiceprints'),
      storage.config.pool?.query('DELETE FROM s2t_users WHERE id = $1', [userId])
    ])
    await storage.vector.client?.dropCollection({ collection_name: storage.vector.collection, db_name: storage.vector.database }).catch(() => undefined)
    await storage.config.pool?.end()
    await storage.vector.client?.closeConnection?.()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
