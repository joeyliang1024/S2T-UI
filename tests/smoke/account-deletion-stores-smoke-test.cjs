const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { LocalConfigStore } = require('../../server/storage/local.cjs')
const { PostgresConfigStore } = require('../../server/storage/remote.cjs')
const { LocalUserStore, PostgresUserStore } = require('../../server/auth/user-store.cjs')

const result = (rows = []) => ({ rows, rowCount: rows.length })

const localStoreContract = async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-account-delete-'))
  try {
    const config = new LocalConfigStore(directory); const users = new LocalUserStore(config)
    const actor = await users.create({ username: 'delete-admin', passwordHash: 'hash', NT: 'Delete Admin', Department: 'Ops', role: 'admin' })
    const target = await users.create({ username: 'delete-target', passwordHash: 'hash', NT: 'Delete Target', Department: 'Ops' })
    const other = await users.create({ username: 'delete-other', passwordHash: 'hash', NT: 'Delete Other', Department: 'Sales' })
    await config.put(target.id, 'sessions', { version: 1, sessions: [{ id: 'private-session' }] })
    await config.put(target.id, 'voiceprints', [{ id: 'target-vector' }])
    await config.put(other.id, 'sessions', { version: 3, sessions: [{ id: 'other-session' }] })
    await config.put(other.id, 'voiceprints', [{ id: 'other-vector' }])
    await config.enqueueDiarizationJob({ id: 'delete-running', userId: target.id, sessionId: 'target-session', audioKey: 'target-audio', payload: { processingToken: 'running' } })
    await config.enqueueDiarizationJob({ id: 'delete-queued', userId: target.id, sessionId: 'target-queued', audioKey: 'target-queued-audio', payload: { processingToken: 'queued' } })
    await config.enqueueDiarizationJob({ id: 'other-queued', userId: other.id, sessionId: 'other-session', audioKey: 'other-audio', payload: { processingToken: 'other' } })
    const running = await config.claimDiarizationJob('delete-worker', 'delete-running')
    assert.ok(running)

    const deleting = await users.markDeleting(target.id, actor.id)
    assert.equal(deleting.deletionState, 'deleting')
    assert.equal((await users.findById(target.id)).deletionState, 'deleting')
    assert.equal((await users.list()).find((user) => user.id === target.id).deletionState, 'deleting')
    assert.equal(await config.getUserState(target.id), 'deleting')
    await assert.rejects(config.enqueueDiarizationJob({ id: 'after-delete', userId: target.id, sessionId: 'after-delete', audioKey: 'after-delete', payload: {} }), /正在刪除/)
    assert.equal(await config.claimDiarizationJob('delete-worker', 'delete-queued'), null, 'a deleting owner cannot be claimed')
    assert.equal(await config.commitDiarizationJob(running.id, 'delete-worker', running.leaseGeneration, target.id, 1, { version: 2, sessions: [] }), 'lost', 'a deleting owner cannot commit a durable job')
    assert.deepEqual(await config.get(target.id, 'sessions'), { version: 1, sessions: [{ id: 'private-session' }] })
    await assert.rejects(users.remove(other.id), /尚未標記刪除/)

    await config.purgeAccount(target.id)
    assert.equal(await config.get(target.id, 'sessions'), null)
    assert.equal(await config.get(target.id, 'voiceprints'), null)
    assert.equal(await config.getDiarizationJob(target.id, 'delete-running'), null)
    assert.equal(await config.getDiarizationJob(target.id, 'delete-queued'), null)
    assert.deepEqual(await config.get(other.id, 'sessions'), { version: 3, sessions: [{ id: 'other-session' }] })
    assert.deepEqual(await config.get(other.id, 'voiceprints'), [{ id: 'other-vector' }])
    assert.ok(await config.getDiarizationJob(other.id, 'other-queued'), 'purge must preserve another owner\'s durable job')
    assert.equal(await users.remove(target.id), true)
    assert.equal(await users.findById(target.id), null)
    assert.equal(await config.getUserState(target.id), null)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

const postgresContract = async () => {
  const queries = []
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (sql.includes('WHERE id = $1 OR id = $2')) return result([
        { id: 'admin', username: 'admin', NT: 'Admin', Department: 'Ops', role: 'admin', createdAt: 'now', deletionState: 'active' },
        { id: 'target', username: 'target', NT: 'Target', Department: 'Ops', role: 'user', createdAt: 'now', deletionState: 'active' }
      ])
      if (sql.includes("WHERE role = 'admin'")) return result([{ id: 'admin' }, { id: 'other-admin' }])
      if (sql.startsWith('UPDATE s2t_users SET deletion_state')) return result([{ id: 'target', username: 'target', NT: 'Target', Department: 'Ops', role: 'user', createdAt: 'now', deletionState: 'deleting' }])
      if (sql.startsWith('SELECT id FROM s2t_diarization_jobs')) return result([{ id: 'job' }])
      if (sql.startsWith('SELECT id FROM s2t_users WHERE id = $1 AND deletion_state')) return result()
      return result()
    },
    release () {}
  }
  const pool = { query: client.query.bind(client), async connect () { return client } }
  const users = new PostgresUserStore(pool)
  const marked = await users.markDeleting('target', 'admin')
  assert.equal(marked.deletionState, 'deleting')
  assert.ok(queries.some(({ sql }) => sql.includes("pg_advisory_xact_lock(hashtext('s2t_users_admin_deletion'))")))
  assert.ok(queries.some(({ sql }) => sql.includes('FOR UPDATE')))
  await users.remove('target')
  assert.ok(queries.some(({ sql }) => sql.includes("DELETE FROM s2t_users WHERE id = $1 AND deletion_state = 'deleting'")))

  const config = Object.create(PostgresConfigStore.prototype)
  config.ready = Promise.resolve(); config.pool = pool
  queries.length = 0
  await config.purgeAccount('target')
  assert.deepEqual(queries.filter(({ sql }) => sql.startsWith('DELETE FROM')).map(({ sql }) => sql), [
    'DELETE FROM s2t_config_records WHERE scope = $1',
    'DELETE FROM s2t_diarization_jobs WHERE user_id = $1',
    'DELETE FROM s2t_voiceprint_records WHERE user_id = $1',
    'DELETE FROM s2t_glossaries WHERE user_id = $1'
  ])
  queries.length = 0
  assert.equal(await config.commitDiarizationJob('job', 'worker', 1, 'target', 1, { version: 2 }), 'lost')
  assert.ok(queries.some(({ sql }) => sql.includes("deletion_state = 'active' FOR KEY SHARE")), 'commit verifies the owner is still active in its transaction')
  queries.length = 0
  await config.claimDiarizationJob('worker')
  assert.ok(queries[0].sql.includes("JOIN s2t_users account ON account.id = job.user_id AND account.deletion_state = 'active'"), 'claim only selects active owners')
}

Promise.all([localStoreContract(), postgresContract()])
  .then(() => console.log('PASS account deletion stores: atomic local state, owner isolation, durable job fence, and PostgreSQL transaction contracts'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
