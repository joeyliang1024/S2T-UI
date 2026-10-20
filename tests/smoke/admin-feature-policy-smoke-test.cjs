const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createServer } = require('node:net')
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-admin-features-'))
  const probe = createServer(); await new Promise((r, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', r) })
  const port = probe.address().port; await new Promise(r => probe.close(r))
  const child = spawn(process.execPath, [resolve('server/index.cjs')], { cwd: directory, env: { PATH: process.env.PATH, S2T_PROCESS_ROLE: 'api', S2T_DATA_DIR: directory, S2T_WEB_HOST: '127.0.0.1', S2T_WEB_PORT: String(port), S2T_AUTH_SECRET: 'admin-feature-policy-secret', S2T_BOOTSTRAP_ADMIN_USERNAME: 'admin', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'test-admin-password', S2T_LOG_LEVEL: 'error' }, stdio: 'ignore' })
  const base = `http://127.0.0.1:${port}`
  const call = async (path, token, body, method) => {
    const response = await fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  try {
    let ready = false
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/readyz')).ok) { ready = true; break } } catch {} await new Promise(r => setTimeout(r, 100)) }
    assert.ok(ready)
    const admin = (await call('/api/auth/login', null, { username: 'admin', password: 'test-admin-password' })).body.token
    const user = (await call('/api/auth/register', null, { username: 'member', password: 'member-password', NT: 'member', Department: 'Engineering' })).body.token
    assert.ok(admin && user)
    const member = (await call('/api/auth/session', user)).body.user
    const adminAccount = (await call('/api/auth/session', admin)).body.user
    assert.equal((await call('/api/admin/users', admin, { username: 'second-admin', password: 'test-second-password', NT: 'second-admin', Department: 'Engineering', role: 'admin' })).status, 400, 'only one admin is permitted')
    assert.equal((await call(`/api/admin/users/${adminAccount.id}/role`, admin, { role: 'developer' }, 'PUT')).status, 409, 'the sole admin cannot be demoted')
    assert.equal((await call(`/api/admin/users/${member.id}/role`, user, { role: 'developer' }, 'PUT')).status, 403, 'users cannot promote themselves')
    const developer = (await call('/api/admin/users', admin, { username: 'developer', password: 'developer-password', NT: 'developer', Department: 'Engineering', role: 'developer' })).body.user
    const devToken = (await call('/api/auth/login', null, { username: 'developer', password: 'developer-password' })).body.token
    assert.equal((await call('/api/auth/session', devToken)).body.user.role, 'developer')
    for (const [path, method, body] of [
      ['/api/admin/users', 'GET'], ['/api/admin/users', 'POST', {}],
      [`/api/admin/users/${member.id}`, 'DELETE'],
      [`/api/admin/users/${member.id}/role`, 'PUT', { role: 'developer' }],
      [`/api/admin/users/${member.id}/sharing-authorization`, 'GET'],
      [`/api/admin/users/${member.id}/sharing-authorization`, 'PUT', { approved: true }]
    ]) assert.equal((await call(path, devToken, body, method)).status, 403, `developer cannot access ${method} ${path}`)
    assert.equal((await call(`/api/admin/users/${member.id}/role`, admin, { role: 'developer' }, 'PUT')).status, 200)
    assert.equal((await call('/api/auth/session', user)).body.user.role, 'developer', 'existing tokens resolve the current role')
    assert.equal((await call(`/api/admin/users/${member.id}/role`, admin, { role: 'user' }, 'PUT')).status, 200)
    assert.equal((await call('/api/auth/session', user)).body.user.role, 'user')
    assert.equal((await call(`/api/admin/users/${member.id}/role`, admin, { role: 'admin' }, 'PUT')).status, 400)
    assert.equal((await call(`/api/admin/users/${member.id}/role`, admin, { role: 'invalid' }, 'PUT')).status, 400)
    assert.equal((await call('/api/voiceprints', devToken)).status, 200)
    assert.equal((await call('/api/data/glossary', devToken, { glossary: 'Developer glossary', version: 0 })).status, 200)

    for (const path of ['/api/data/model-registry', '/api/data/model-credentials/test', '/api/data/model-test', '/api/data/glossary', '/api/voiceprints', '/api/data/storage-retry', '/api/data/storage-audit']) assert.equal((await call(path, user, {})).status, 403, path)
    const models = [{ id: 'shared-asr', name: 'Shared', purpose: 'asr', endpoint: 'http://127.0.0.1:9/v1', model: 'test', requiresApiKey: true }]
    assert.equal((await call('/api/data/model-registry', admin, { version: 0, models })).status, 200)
    assert.equal((await call('/api/data/model-registry', devToken, { version: 1, models })).status, 403, 'developer cannot change shared models')
    const registry = await call('/api/data/model-registry', user)
    assert.equal(registry.body.models[0].id, 'shared-asr')
    assert.equal((await call('/api/data/model-credentials/shared-asr', admin, { apiKey: 'never-return-this-secret' })).status, 204)
    assert.ok(!JSON.stringify(registry.body).includes('never-return-this-secret'))
    const settings = { selectedModelId: 'shared-asr', translationLoadStrategy: 'throttled', denoiseEnabled: true }
    assert.equal((await call('/api/data/settings', admin, { version: 0, settings })).status, 200)
    assert.equal((await call('/api/data/settings', user)).body.settings.selectedModelId, 'shared-asr')
    assert.equal((await call('/api/data/settings', user, { version: 0, settings: { selectedModelId: 'override', translationLoadStrategy: 'manual', denoiseEnabled: false } })).status, 200)
    const effective = (await call('/api/data/settings', user)).body.settings
    assert.equal(effective.selectedModelId, 'shared-asr'); assert.equal(effective.translationLoadStrategy, 'throttled'); assert.equal(effective.denoiseEnabled, false)
    assert.equal((await call('/api/data/model-credentials/shared-asr', devToken, { apiKey: 'developer-model-secret' })).status, 403)
    assert.equal((await call('/api/data/model-credentials/shared-asr', devToken, undefined, 'DELETE')).status, 403)
    assert.equal((await call('/api/data/settings', devToken, { version: 0, settings: { ...settings, translationLoadStrategy: 'manual', selectedModelId: 'developer-override', summaryEndpoint: 'https://invalid.example/v1', adminParameters: { translationTemperature: .4 } } })).status, 200, 'developer can use detailed parameters')
    const developerSettings = (await call('/api/data/settings', devToken)).body.settings
    assert.equal(developerSettings.adminParameters.translationTemperature, .4)
    assert.equal(developerSettings.translationLoadStrategy, 'manual', 'developer advanced settings remain personal')
    const adminSettingsAfterDeveloper = await call('/api/data/settings', admin)
    assert.equal(adminSettingsAfterDeveloper.body.version, 1, 'developer save must not invalidate admin settings version')
    assert.equal(adminSettingsAfterDeveloper.body.settings.translationLoadStrategy, 'throttled')
    assert.equal(developerSettings.selectedModelId, 'shared-asr')
    assert.equal(developerSettings.summaryEndpoint, undefined, 'developer cannot introduce a new model endpoint')
    assert.equal((await call('/api/data/settings', admin)).body.settings.selectedModelId, 'shared-asr')
    assert.equal((await call('/api/data/settings', admin)).body.settings.summaryEndpoint, undefined)
    assert.equal((await call('/api/data/settings', user)).body.settings.adminParameters, undefined)
    assert.ok(developer.id)
    const response = await fetch(base + '/api/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${user}`, 'content-type': 'text/plain', 'x-s2t-model-id': 'shared-asr' }, body: 'invalid audio' })
    assert.equal(response.status, 415, 'member resolves admin credentials before audio validation')
    console.log('PASS single admin, role changes, developer feature access and account-management denial, shared models/credentials, advanced parameters and user restrictions')
  } finally { child.kill('SIGTERM'); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); await rm(directory, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
