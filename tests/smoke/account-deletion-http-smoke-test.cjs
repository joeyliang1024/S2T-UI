const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createStorage } = require('../../server/storage/index.cjs')
const { LocalUserStore } = require('../../server/auth/user-store.cjs')

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-delete-http-'))
  const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [resolve('server/index.cjs')], { cwd: directory, env: { PATH: process.env.PATH, S2T_WEB_PORT: String(port), S2T_DATA_DIR: directory, S2T_AUTH_SECRET: 'isolated-account-deletion-http-secret', S2T_BOOTSTRAP_ADMIN_USERNAME: 'admin', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'isolated-admin-password', S2T_PROCESS_ROLE: 'api', S2T_LOG_LEVEL: 'silent' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; child.stdout.on('data', bytes => { logs += bytes }); child.stderr.on('data', bytes => { logs += bytes })
  const storage = createStorage({ S2T_DATA_DIR: directory }), users = new LocalUserStore(storage.config)
  const request = async (path, token = '', method = 'GET', input) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(15000) })
    return { status: response.status, body: await response.json() }
  }
  try {
    await eventually(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(base + '/livez')).ok } catch { return false } })
    const admin = (await request('/api/auth/login', '', 'POST', { username: 'admin', password: 'isolated-admin-password' })).body
    assert.ok(admin.token)
    const create = async username => { const response = await request('/api/admin/users', admin.token, 'POST', { username, password: 'isolated-member-password', NT: username, Department: 'Fixture', role: 'user' }); assert.equal(response.status, 201); return response.body.user }
    const target = await create('target'), other = await create('other')
    const login = (await request('/api/auth/login', '', 'POST', { username: 'target', password: 'isolated-member-password' })).body
    const endpoint = `/api/admin/users/${target.id}`
    assert.equal((await request(endpoint, '', 'DELETE')).status, 401)
    assert.equal((await request(endpoint, login.token, 'DELETE')).status, 403)
    assert.equal((await request(`/api/admin/users/${admin.user.id}`, admin.token, 'DELETE')).status, 409)
    for (const account of [target, other]) {
      await storage.config.put(account.id, 'sessions', { sessions: [], version: 1 })
      await storage.config.put(account.id, 'voiceprints', [{ id: `voice-${account.id}` }])
      await storage.blob.put(account.id, 'audio/fixture', Buffer.from(account.id))
      await storage.vector.upsert({ id: `voice-${account.id}`, NT: account.NT, Department: account.Department, embedding: [1, 0] })
    }
    // A broken vector backend must not turn partial cleanup into DELETE success.
    const vectorFile = join(directory, 'vectors.json'), original = await readFile(vectorFile)
    await writeFile(vectorFile, '{')
    assert.equal((await request(endpoint, admin.token, 'DELETE')).status, 503)
    assert.equal((await users.findById(target.id)).deletionState, 'deleting')
    assert.equal((await request('/api/auth/session', login.token)).status, 401, 'old tokens are disabled while cleanup is incomplete')
    assert.equal((await request('/api/auth/login', '', 'POST', { username: 'target', password: 'isolated-member-password' })).status, 401)
    const accounts = (await request('/api/admin/users', admin.token)).body.users
    assert.equal(accounts.find(account => account.id === target.id).deletionState, 'deleting', 'admin can find and retry interrupted cleanup')
    await writeFile(vectorFile, original)
    assert.deepEqual(await request(endpoint, admin.token, 'DELETE'), { status: 200, body: { deleted: true } })
    assert.equal(await users.findById(target.id), null)
    assert.deepEqual(await storage.blob.list(target.id), [])
    assert.deepEqual(await storage.config.list(target.id), [])
    assert.deepEqual((await storage.vector.records()).map(record => record.id), [`voice-${other.id}`])
    assert.deepEqual(await storage.blob.get(other.id, 'audio/fixture'), Buffer.from(other.id))
    assert.ok(await users.findById(other.id))
    assert.equal((await request('/api/auth/session', login.token)).status, 401)
    assert.equal((await request(endpoint, admin.token, 'DELETE')).status, 200, 'retry after a lost successful response is idempotent')
    const second = await request('/api/admin/users', admin.token, 'POST', { username: 'secondadmin', password: 'isolated-member-password', NT: 'secondadmin', Department: 'Fixture', role: 'admin' })
    assert.equal(second.status, 400, 'a second admin cannot be created')
    assert.equal((await request(`/api/admin/users/${admin.user.id}`, admin.token, 'DELETE')).status, 409, 'the sole admin cannot delete itself')
    assert.equal((await request('/api/auth/session', admin.token)).status, 200, 'the sole admin remains usable')
    console.log('PASS HTTP admin-only deletion, self protection, token/login revocation, visible incomplete cleanup, retry and cross-owner blob/config/vector isolation')
  } finally {
    const exited = new Promise(done => child.once('exit', done)); child.kill('SIGTERM'); await Promise.race([exited, new Promise(done => setTimeout(done, 3000))]); if (child.exitCode === null) child.kill('SIGKILL')
    await storage.close(); await rm(directory, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
async function eventually(check) { const deadline = Date.now() + 10000; while (!await check()) { if (Date.now() > deadline) throw new Error('gateway did not start'); await new Promise(done => setTimeout(done, 30)) } }
