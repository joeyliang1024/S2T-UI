const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createStorage } = require('../server/storage/index.cjs')

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-storage-'))
  try {
    const storage = createStorage({ S2T_LOCAL_DATA_DIR: directory })
    await storage.ready
    assert.deepEqual(storage.mode, { blob: 'local', config: 'local', vector: 'local' })

    await storage.config.put('alice', 'session-1', { text: 'Alice 的逐字稿' })
    await storage.config.put('bob', 'session-1', { text: 'Bob 的逐字稿' })
    assert.deepEqual(await storage.config.get('alice', 'session-1'), { text: 'Alice 的逐字稿' })
    assert.deepEqual(await storage.config.get('bob', 'session-1'), { text: 'Bob 的逐字稿' })

    await storage.blob.put('alice', 'sessions/audio.wav', Buffer.from('alice-audio'))
    await storage.blob.put('bob', 'sessions/audio.wav', Buffer.from('bob-audio'))
    assert.equal((await storage.blob.get('alice', 'sessions/audio.wav')).toString(), 'alice-audio')
    assert.equal((await storage.blob.get('bob', 'sessions/audio.wav')).toString(), 'bob-audio')

    await storage.vector.upsert({ id: 'alice-v1', NT: 'alice', Department: 'R&D', embedding: [1, 0, 0] })
    await storage.vector.upsert({ id: 'bob-v1', NT: 'bob', Department: 'Sales', embedding: [0, 1, 0] })
    assert.equal((await storage.vector.nearest([.9, .1, 0], 1))[0].NT, 'alice')
    await storage.vector.remove('alice-v1')
    assert.equal((await storage.vector.nearest([1, 0, 0], 5)).some((item) => item.NT === 'alice'), false)
    console.log('Local storage smoke test passed.')
  } finally { await rm(directory, { recursive: true, force: true }) }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
