const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createStorage } = require('../../server/storage/index.cjs')
const { LocalUserStore } = require('../../server/auth/user-store.cjs')
const { createAccountDeletionService } = require('../../server/auth/delete-account.cjs')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-account-delete-'))
  const storage = createStorage({ S2T_LOCAL_DATA_DIR: directory })
  const users = new LocalUserStore(storage.config)
  const create = name => users.create({ username: name, passwordHash: 'not-a-login', NT: name, Department: 'fixture', role: name === 'admin' ? 'admin' : 'user' })
  const release = deferred()
  let writer
  try {
    await storage.ready
    const actor = await create('admin'), target = await create('target'), other = await create('other')
    for (const user of [target, other]) {
      await storage.config.put(user.id, 'sessions', { version: 1, sessions: [{ id: 'fixture' }] })
      await storage.config.put(user.id, 'settings', { private: user.id })
      await storage.config.put(user.id, 'voiceprints', [{ id: `voice-${user.id}` }])
      await storage.config.put(user.id, 'voiceprint-compensations', [{ id: `orphan-${user.id}`, type: 'enroll-cleanup' }])
      await storage.blob.put(user.id, 'audio/recording', Buffer.from(user.id))
      await storage.blob.put(user.id, 'recordings/chunks/0', Buffer.from('chunk'))
      for (const prefix of ['voice', 'orphan']) await storage.vector.upsert({ id: `${prefix}-${user.id}`, NT: user.NT, Department: 'fixture', embedding: [1, 0] })
      await storage.config.enqueueDiarizationJob({ id: `job-${user.id}`, userId: user.id, sessionId: 'fixture', audioKey: 'recording', payload: { user } })
    }
    const removeVector = storage.vector.remove.bind(storage.vector)
    let fail = true
    storage.vector.remove = async id => { if (fail) { fail = false; throw new Error('temporary vector failure') } await removeVector(id) }
    const removeAccount = createAccountDeletionService({ storage, users })
    await assert.rejects(removeAccount(actor.id, actor.id), error => error.status === 409)
    const started = deferred()
    writer = storage.withAccountWrite(target.id, async () => { started.resolve(); await release.promise; await storage.blob.put(target.id, 'audio/late-write', Buffer.from('late')) })
    await started.promise
    let settled = false
    const deleting = removeAccount(target.id, actor.id).finally(() => { settled = true })
    const failed = assert.rejects(deleting, /temporary vector failure/)
    await eventually(async () => (await users.findById(target.id))?.deletionState === 'deleting')
    assert.equal(settled, false, 'deletion waits for an already-admitted writer')
    await assert.rejects(storage.withAccountWrite(target.id, async () => assert.fail('new writer admitted')), error => error.code === 'ACCOUNT_DELETING')
    release.resolve(); await writer; await failed
    assert.equal((await users.findById(target.id)).deletionState, 'deleting', 'failed cleanup retains disabled identity for retry')
    assert.deepEqual(await storage.blob.list(target.id), [], 'late accepted upload is removed after drain')
    assert.ok(await storage.config.get('account-deletions', target.id), 'vector cleanup intent survives a failed removal')
    assert.deepEqual(await removeAccount(target.id, actor.id), { deleted: true })
    assert.equal(await users.findById(target.id), null)
    assert.deepEqual(await storage.config.list(target.id), [])
    assert.deepEqual(await storage.blob.list(target.id), [])
    const remainingVectors = (await storage.vector.records()).map(row => row.id).sort()
    assert.deepEqual(remainingVectors, [`orphan-${other.id}`, `voice-${other.id}`].sort())
    assert.equal(await storage.config.getDiarizationJob(target.id, `job-${target.id}`), null)
    assert.ok(await storage.config.getDiarizationJob(other.id, `job-${other.id}`))
    assert.ok(await users.findById(other.id))
    assert.deepEqual(await storage.blob.get(other.id, 'audio/recording'), Buffer.from(other.id))
    assert.deepEqual(await storage.config.get(other.id, 'settings'), { private: other.id })
    assert.equal(await storage.config.get('account-deletions', target.id), null)
    assert.deepEqual(await removeAccount(target.id, actor.id), { deleted: true }, 'repeated deletion is idempotent')
    console.log('PASS account deletion: real local blobs/config/vectors/jobs, admitted-write drain, denial of new writes, failed-vector retry journal and owner isolation')
  } finally { release.resolve(); await writer?.catch(() => {}); await storage.close(); await rm(directory, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })

async function eventually(check) { const deadline = Date.now() + 5000; while (!await check()) { if (Date.now() > deadline) throw new Error('deletion state did not become visible'); await new Promise(resolve => setTimeout(resolve, 10)) } }
