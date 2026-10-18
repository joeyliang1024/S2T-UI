const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { PostgresConfigStore } = require('../../server/storage/remote.cjs')
const { setSharingAuthorization } = require('../../server/auth/sharing-authorization.cjs')

;(async () => {
  if (!process.env.S2T_TEST_POSTGRES_PASSWORD) throw new Error('Use an isolated test PostgreSQL database')
  const store = new PostgresConfigStore({
    S2T_POSTGRES_HOST: process.env.S2T_TEST_POSTGRES_HOST || '127.0.0.1',
    S2T_POSTGRES_PORT: process.env.S2T_TEST_POSTGRES_PORT || '16439',
    S2T_POSTGRES_DB_NAME: process.env.S2T_TEST_POSTGRES_DB || 'postgres',
    S2T_POSTGRES_USER: process.env.S2T_TEST_POSTGRES_USER || 'postgres',
    S2T_POSTGRES_PASSWORD: process.env.S2T_TEST_POSTGRES_PASSWORD
  })
  const run = randomUUID(), owner = `owner-${run}`, viewer = `viewer-${run}`
  const embeddingModel = `fixture-${run}`, embeddingVersion = '1'
  const visible = async userId => (await store.findVisibleVoiceprintIds({ userId, embeddingModel, embeddingVersion })).sort()
  const grant = (id, department, approved = true) => setSharingAuthorization(store, id, { department, approved }, 'fixture-admin')
  try {
    await store.ready
    for (const id of [owner, viewer]) await store.pool.query('INSERT INTO s2t_users(id, username, password_hash, nt, department) VALUES($1,$1,$2,$1,$3)', [id, 'not-a-login', 'Forged'])
    for (const sharingScope of ['private', 'department', 'organization']) await store.createVoiceprint({ vectorId: `${sharingScope}-${run}`, userId: owner, embeddingModel, embeddingVersion, sharingScope })
    assert.equal((await visible(owner)).length, 3)
    assert.deepEqual(await visible(viewer), [], 'self-declared profile department grants no visibility')
    await grant(owner, 'Trusted')
    assert.deepEqual(await visible(viewer), [], 'viewer also requires trusted approval')
    await grant(viewer, 'Trusted')
    assert.deepEqual(await visible(viewer), [`department-${run}`, `organization-${run}`])
    await grant(viewer, 'Other')
    assert.deepEqual(await visible(viewer), [`organization-${run}`])
    await grant(owner, 'Trusted', false)
    assert.deepEqual(await visible(viewer), [], 'owner revocation removes all shared visibility')
    assert.equal((await visible(owner)).length, 3, 'revocation preserves owner access')
    await grant(owner, 'Trusted'); await grant(viewer, 'Trusted', false)
    assert.deepEqual(await visible(viewer), [], 'viewer revocation applies immediately')
    const mismatch = await store.findVisibleVoiceprintIds({ userId: owner, embeddingModel, embeddingVersion: 'other' })
    assert.deepEqual(mismatch, [], 'embedding versions remain isolated')
    console.log('PASS real PostgreSQL trusted sharing: profile forgery, department/organization scope, both-side revocation and model version isolation')
  } finally {
    await store.pool.query('DELETE FROM s2t_config_records WHERE scope = ANY($1::text[])', [[owner, viewer]]).catch(() => {})
    await store.pool.query('DELETE FROM s2t_users WHERE id = ANY($1::text[])', [[owner, viewer]]).catch(() => {})
    await store.pool.end()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
