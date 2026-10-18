const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { join } = require('node:path'), { tmpdir } = require('node:os')
const { createStorage } = require('../../server/storage/index.cjs')
const { createAuth } = require('../../server/auth/index.cjs')
const { validateSharingEnrollment, setSharingAuthorization } = require('../../server/auth/sharing-authorization.cjs')
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-auth-policy-'))
  const storage = createStorage({ S2T_LOCAL_DATA_DIR: directory }); await storage.ready
  const env = { S2T_LOCAL_DATA_DIR: directory, S2T_AUTH_SECRET: 'test-policy-secret-12345678901234567890' }
  try {
    await assert.rejects(createAuth(storage, env), /首次啟動/)
    await assert.rejects(createAuth(storage, { ...env, NODE_ENV: 'production', S2T_ALLOW_DEFAULT_ADMIN: 'true' }), /首次啟動/)
    await assert.rejects(createAuth(storage, { ...env, NODE_ENV: 'production', S2T_BOOTSTRAP_ADMIN_USERNAME: 'admin', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'admin' }), /12/)
    const auth = await createAuth(storage, { ...env, S2T_BOOTSTRAP_ADMIN_USERNAME: 'admin', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'bootstrap-password' })
    await assert.doesNotReject(createAuth(storage, { ...env, NODE_ENV: 'production' }), 'existing admin survives absent bootstrap credentials')
    const { user, token } = await auth.register({ username: 'member', password: 'member-password', NT: 'member', Department: 'R&D', sharingAuthorization: { approved: true } })
    await assert.rejects(validateSharingEnrollment(storage.config, user.id, 'department', 'true'), error => error.status === 403)
    await setSharingAuthorization(storage.config, user.id, { approved: true, department: 'Trusted' }, 'admin')
    await assert.rejects(validateSharingEnrollment(storage.config, user.id, 'department', undefined), error => error.status === 400)
    await assert.doesNotReject(validateSharingEnrollment(storage.config, user.id, 'department', 'true'))
    const update = storage.config.update.bind(storage.config)
    storage.config.update = async () => { throw new Error('injected revocation outage') }
    await assert.rejects(auth.revoke(token), /injected revocation outage/)
    assert.ok(await auth.session(token), 'failed revocation must not be reported as token invalidation')
    storage.config.update = update
    await Promise.all([auth.revoke(token), auth.revoke(token)])
    assert.equal(await auth.session(token), null)
    await assert.doesNotReject(auth.revoke('invalid-token'))
    console.log('PASS bootstrap guard, existing admin, trusted sharing approval, revocation outage and concurrent logout')
  } finally { await rm(directory, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
