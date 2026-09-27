const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { promisify } = require('node:util')
const { createStorage } = require('../server/storage/index.cjs')
const { LocalUserStore } = require('../server/auth/user-store.cjs')
const { createAuth } = require('../server/auth/index.cjs')

const execFileAsync = promisify(execFile)

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

    await Promise.all(Array.from({ length: 24 }, (_, index) => storage.config.put('alice', `parallel-${index}`, { index })))
    await Promise.all(Array.from({ length: 24 }, async (_, index) => assert.deepEqual(await storage.config.get('alice', `parallel-${index}`), { index })))
    assert.equal(await storage.config.compareAndSwap('alice', 'sessions', 0, { version: 1, sessions: [{ id: 'one' }] }), true)
    assert.equal(await storage.config.compareAndSwap('alice', 'sessions', 0, { version: 1, sessions: [{ id: 'stale' }] }), false)
    assert.equal(await storage.config.compareAndSwap('alice', 'sessions', 1, { version: 2, sessions: [{ id: 'two' }] }), true)
    assert.deepEqual(await storage.config.get('alice', 'sessions'), { version: 2, sessions: [{ id: 'two' }] })

    const worker = (writer) => execFileAsync(process.execPath, [join(__dirname, 'storage-local-cas-worker.cjs')], { cwd: join(__dirname, '..'), env: { ...process.env, S2T_LOCAL_CAS_DIRECTORY: directory, S2T_LOCAL_CAS_WRITER: writer } })
    const localCas = await Promise.all([worker('first'), worker('second')])
    const localCasResults = localCas.map(({ stdout }) => JSON.parse(stdout))
    assert.equal(localCasResults.filter((result) => result.won).length, 1, 'two local processes must not both win the same CAS')
    assert.equal((await storage.config.get('cross-process', 'sessions')).version, 1)

    const users = new LocalUserStore(storage.config)
    const registration = await Promise.allSettled([
      users.create({ username: 'same-user', passwordHash: 'hash-a', NT: 'Same', Department: 'R&D' }),
      users.create({ username: 'same-user', passwordHash: 'hash-b', NT: 'Same', Department: 'R&D' })
    ])
    assert.equal(registration.filter((result) => result.status === 'fulfilled').length, 1)

    const initialAuth = await createAuth(storage, { S2T_LOCAL_DATA_DIR: directory, S2T_AUTH_SECRET: 'storage-smoke-auth-secret', S2T_BOOTSTRAP_ADMIN_USERNAME: 'bootstrap-user', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'original-password' })
    await assert.doesNotReject(initialAuth.login({ username: 'bootstrap-user', password: 'original-password' }))
    const restartedAuth = await createAuth(storage, { S2T_LOCAL_DATA_DIR: directory, S2T_AUTH_SECRET: 'storage-smoke-auth-secret', S2T_BOOTSTRAP_ADMIN_USERNAME: 'bootstrap-user', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'replacement-password' })
    await assert.doesNotReject(restartedAuth.login({ username: 'bootstrap-user', password: 'original-password' }), 'bootstrap settings must not overwrite an existing user')
    await assert.rejects(restartedAuth.login({ username: 'bootstrap-user', password: 'replacement-password' }))

    await storage.blob.put('alice', 'sessions/audio.wav', Buffer.from('alice-audio'))
    await storage.blob.put('bob', 'sessions/audio.wav', Buffer.from('bob-audio'))
    assert.equal((await storage.blob.get('alice', 'sessions/audio.wav')).toString(), 'alice-audio')
    assert.equal((await storage.blob.get('bob', 'sessions/audio.wav')).toString(), 'bob-audio')
    assert.deepEqual(await storage.blob.list('alice', 'sessions'), ['sessions/audio.wav'])

    await storage.vector.upsert({ id: 'alice-v1', NT: 'alice', Department: 'R&D', embedding: [1, 0, 0] })
    await storage.vector.upsert({ id: 'bob-v1', NT: 'bob', Department: 'Sales', embedding: [0, 1, 0] })
    assert.equal((await storage.vector.nearest([.9, .1, 0], 1, ['alice-v1']))[0].NT, 'alice')
    assert.equal((await storage.vector.nearest([.9, .1, 0], 1, ['bob-v1']))[0].NT, 'bob')
    assert.deepEqual(await storage.vector.nearest([.9, .1, 0], 1), [])
    await storage.config.put('alice', 'voiceprints', [{ id: 'alice-shared', Department: 'R&D', embeddingModel: 'model', embeddingVersion: 'v1', sharingScope: 'department' }, { id: 'alice-private', Department: 'R&D', embeddingModel: 'model', embeddingVersion: 'v1', sharingScope: 'private' }])
    await storage.config.put('bob', 'voiceprints', [{ id: 'bob-global', Department: 'Sales', embeddingModel: 'model', embeddingVersion: 'v1', sharingScope: 'organization' }])
    assert.deepEqual((await storage.config.findVisibleVoiceprintIds({ userId: 'carol', department: 'R&D', embeddingModel: 'model', embeddingVersion: 'v1' })).sort(), ['alice-shared', 'bob-global'])
    await storage.vector.remove('alice-v1')
    assert.equal((await storage.vector.nearest([1, 0, 0], 5, ['alice-v1'])).some((item) => item.NT === 'alice'), false)

    await writeFile(join(directory, 'vectors.json'), '{invalid')
    await assert.rejects(storage.vector.nearest([0, 1, 0], 1, ['bob-v1']), /格式損毀/)
    console.log('Local storage smoke test passed.')
  } finally { await rm(directory, { recursive: true, force: true }) }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
