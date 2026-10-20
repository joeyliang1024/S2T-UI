const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createStorage } = require('../../server/storage/index.cjs')
const { LocalUserStore, PostgresUserStore } = require('../../server/auth/user-store.cjs')
const { preserveModelSettings } = require('../../src/shared/validation/model-settings.cjs')
const savedModel = { selectedModelId: 'admin-model', modelProfiles: [{ id: 'admin-model', endpoint: 'https://admin.example/v1' }] }
const protectedSettings = preserveModelSettings({ selectedModelId: 'injected', modelProfiles: [], summaryEndpoint: 'https://injected.example/v1', denoiseEnabled: false, adminParameters: { translationTemperature: .4 } }, savedModel)
assert.equal(protectedSettings.selectedModelId, 'admin-model')
assert.deepEqual(protectedSettings.modelProfiles, savedModel.modelProfiles)
assert.equal(protectedSettings.summaryEndpoint, undefined)
assert.equal(protectedSettings.denoiseEnabled, false)
assert.equal(protectedSettings.adminParameters.translationTemperature, .4)
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-account-roles-'))
  const storage = createStorage({ S2T_DATA_DIR: directory }); await storage.ready
  try {
    const users = new LocalUserStore(storage.config)
    const input = (name, role) => ({ username: name, NT: name, Department: 'test', passwordHash: 'fixture', role })
    const attempts = await Promise.allSettled([users.create(input('admin-one', 'admin')), users.create(input('admin-two', 'admin'))])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1, 'concurrent admin creation yields one admin')
    const admin = attempts.find(result => result.status === 'fulfilled').value
    assert.equal((await users.findAdmin()).id, admin.id)
    const originalList = users.list
    users.list = async () => [] // A paginated account listing must not decide model ownership.
    assert.equal((await users.findAdmin()).id, admin.id)
    users.list = originalList
    const developer = await users.create(input('developer', 'developer'))
    const user = await users.create(input('member', 'user'))
    assert.equal((await users.findById(developer.id)).role, 'developer')
    await assert.rejects(users.setRole(user.id, 'developer', developer.id), error => error.status === 403)
    await assert.rejects(users.setRole(user.id, 'admin', admin.id), error => error.status === 400)
    await assert.rejects(users.setRole(admin.id, 'user', admin.id), error => error.status === 409)
    assert.equal((await users.setRole(user.id, 'developer', admin.id)).role, 'developer')
    assert.equal((await users.setRole(user.id, 'user', admin.id)).role, 'user')
    await users.markDeleting(user.id, admin.id)
    await assert.rejects(users.setRole(user.id, 'developer', admin.id), error => error.status === 409)
    // Simulate a pre-migration database containing an additional admin.
    const legacy = { ...developer, role: 'admin', passwordHash: 'fixture', createdAt: '2099-01-01' }
    await storage.config.put('auth', 'account-developer', legacy)
    await users.ensureSingleAdmin(); await users.ensureSingleAdmin()
    assert.equal((await users.findById(admin.id)).role, 'admin')
    assert.equal((await users.findById(developer.id)).role, 'developer')
    assert.equal((await users.list()).filter(account => account.role === 'admin').length, 1)
    await assert.rejects(users.create(input('third-admin', 'admin')), error => error.status === 409)
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }) }
  const queries = [], result = rows => ({ rows, rowCount: rows.length })
  const accounts = [{ id: 'admin', role: 'admin', deletion_state: 'active' }, { id: 'member', username: 'member', NT: 'member', Department: 'test', role: 'user', deletion_state: 'active' }]
  let released = 0
  const client = { async query(sql, values) {
    queries.push(sql)
    if (sql.includes('WHERE id = $1 OR id = $2')) return result(accounts)
    if (sql.startsWith('UPDATE s2t_users SET role = $2')) { accounts[1].role = values[1]; return result([accounts[1]]) }
    return result([])
  }, release() { released++ } }
  const postgres = new PostgresUserStore({ connect: async () => client, query: async sql => {
    assert.ok(sql.includes("role = 'admin'") && !sql.includes('LIMIT 1000')); return result([{ id: 'admin' }])
  } })
  assert.equal((await postgres.findAdmin()).id, 'admin')
  assert.equal((await postgres.setRole('member', 'developer', 'admin')).role, 'developer')
  assert.ok(queries.some(sql => sql.includes('ORDER BY id FOR UPDATE')))
  assert.ok(queries.includes('COMMIT'))
  await assert.rejects(postgres.setRole('admin', 'user', 'admin'), error => error.status === 409)
  assert.equal(queries.at(-1), 'ROLLBACK')
  await postgres.ensureSingleAdmin()
  assert.ok(queries.some(sql => sql.includes('pg_advisory_xact_lock')))
  assert.ok(queries.some(sql => sql.includes('CREATE UNIQUE INDEX') && sql.includes("WHERE role = 'admin'")))
  assert.equal(released, 3)
  console.log('PASS local singleton concurrency/migration, role authorization/deletion guards, PostgreSQL locked role updates and singleton index contract')
})().catch(error => { console.error(error); process.exitCode = 1 })
