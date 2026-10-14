const assert = require('node:assert/strict')
const { createServer } = require('node:http'), { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises'), { tmpdir } = require('node:os'), { join } = require('node:path')
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-sharing-http-'))
  const audio = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    assert.equal(req.headers.authorization, 'Bearer audio-test-token')
    const value = req.url.endsWith('/assessVoiceprintSample') ? { durationMs: 5000, rmsDbfs: -18 } : [1, 0, 0]
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value }))
  })
  await new Promise(resolve => audio.listen(0, '127.0.0.1', resolve))
  const port = 21000 + Math.floor(Math.random() * 1000), base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [join(__dirname, '../../server/index.cjs')], { cwd: directory, env: {
    PATH: process.env.PATH, S2T_LOCAL_DATA_DIR: directory, S2T_AUTH_SECRET: 'isolated-sharing-http-test-secret',
    S2T_BOOTSTRAP_ADMIN_USERNAME: 'admin', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'admin-password', S2T_WEB_PORT: String(port),
    S2T_PROCESS_ROLE: 'api', S2T_AUDIO_SERVICE_URL: `http://127.0.0.1:${audio.address().port}`, S2T_AUDIO_SERVICE_TOKEN: 'audio-test-token'
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; child.stdout.on('data', value => { logs += value }); child.stderr.on('data', value => { logs += value })
  const request = async (path, token, input, method = input ? 'POST' : 'GET', headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers }, ...(input ? { body: Buffer.isBuffer(input) ? input : JSON.stringify(input) } : {}), signal: AbortSignal.timeout(10000) })
    return { status: res.status, body: res.status === 204 ? null : await res.json() }
  }
  try {
    const deadline = Date.now() + 15000
    while (!logs.includes('gateway.started')) { if (child.exitCode !== null || Date.now() > deadline) throw new Error(logs); await new Promise(resolve => setTimeout(resolve, 50)) }
    const admin = (await request('/api/auth/login', '', { username: 'admin', password: 'admin-password' })).body.token
    const owner = (await request('/api/auth/register', '', { username: 'owner', password: 'member-password', NT: 'owner', Department: 'Forged' })).body
    const viewer = (await request('/api/auth/register', '', { username: 'viewer', password: 'member-password', NT: 'viewer', Department: 'Trusted' })).body
    const sharing = { 'content-type': 'audio/wav', 'x-s2t-voiceprint-sharing': 'department', 'x-s2t-voiceprint-consent': 'true' }
    assert.equal((await request('/api/voiceprints', owner.token, Buffer.from('mock'), 'POST', sharing)).status, 403)
    const grant = (account, department, approved = true, token = admin) => request(`/api/admin/users/${account.user.id}/sharing-authorization`, token, { approved, department }, 'PUT')
    assert.equal((await grant(owner, 'Trusted', true, owner.token)).status, 403)
    assert.equal((await grant(owner, 'Trusted')).status, 200)
    const enrolled = await request('/api/voiceprints', owner.token, Buffer.from('mock'), 'POST', sharing)
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body))
    const identify = () => request('/api/voiceprints/identify', viewer.token, Buffer.from('mock'), 'POST', { 'content-type': 'audio/wav' })
    assert.equal((await identify()).body.match, null, 'self-declared matching department is insufficient')
    await grant(viewer, 'Trusted'); assert.equal((await identify()).body.match.NT, 'owner')
    await grant(viewer, 'Other'); assert.equal((await identify()).body.match, null)
    await grant(viewer, 'Trusted'); await grant(owner, 'Trusted', false); assert.equal((await identify()).body.match, null)
    await grant(owner, 'Trusted'); await grant(viewer, 'Other')
    assert.equal((await request('/api/voiceprints', owner.token, Buffer.from('mock'), 'POST', { ...sharing, 'x-s2t-voiceprint-sharing': 'organization' })).status, 201)
    assert.equal((await identify()).body.match.NT, 'owner', 'approved organization sharing spans trusted departments')
    console.log('PASS HTTP enrollment consent, public self-approval rejection, trusted department isolation and revoked/organization visibility')
  } finally {
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))]); if (child.exitCode === null) child.kill('SIGKILL')
    await new Promise(resolve => audio.close(resolve)); await rm(directory, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
