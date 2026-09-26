const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const request = async (base, path, options = {}) => {
  const response = await fetch(`${base}${path}`, options)
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  return { response, body }
}

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-gateway-auth-'))
  const port = 19000 + Math.floor(Math.random() * 1000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.cjs'], {
    cwd: join(__dirname, '..'),
    // Keep this test independent from a developer's remote-storage .env.
    // dotenv does not override already-defined empty values, so the gateway
    // reliably selects the local adapters used by this isolated smoke test.
    env: { ...process.env, S2T_WEB_PORT: String(port), S2T_LOCAL_DATA_DIR: directory, S2T_WEB_ORIGINS: 'http://127.0.0.1:5173,null', S2T_BOOTSTRAP_ADMIN_USERNAME: '', S2T_BOOTSTRAP_ADMIN_PASSWORD: '', S2T_MINIO_ENDPOINT: '', S2T_MINIO_BUCKET: '', S2T_MINIO_ACCESS_KEY: '', S2T_MINIO_SECRET_KEY: '', S2T_POSTGRES_HOST: '', S2T_POSTGRES_PORT: '', S2T_POSTGRES_DB_NAME: '', S2T_POSTGRES_USER: '', S2T_POSTGRES_PASSWORD: '', S2T_MILVUS_ENDPOINT: '', S2T_MILVUS_DB_NAME: '', S2T_MILVUS_COLLECTION: '', S2T_MILVUS_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (value) => { output += value })
  child.stderr.on('data', (value) => { output += value })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway did not start: ${output}`)), 10_000)
      child.stdout.on('data', () => {
        if (output.includes('S2T web gateway:')) { clearTimeout(timer); resolve() }
      })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`gateway exited (${code}): ${output}`)) })
    })
    for (const path of ['/api/data/sessions', '/api/data/summary-templates', '/api/voiceprints', '/api/voiceprints/identify', '/api/diarizations']) {
      const { response } = await request(base, path, path === '/api/data/sessions' || path === '/api/data/summary-templates' || path === '/api/voiceprints' ? {} : { method: 'POST', body: Buffer.from('x') })
      assert.equal(response.status, 401, `${path} must require authentication`)
    }
    for (const origin of ['http://127.0.0.1:5173', 'null']) {
      const preflight = await request(base, '/api/voiceprints/example', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'DELETE' } })
      assert.equal(preflight.response.status, 204)
      assert.equal(preflight.response.headers.get('access-control-allow-origin'), origin)
      assert.match(preflight.response.headers.get('access-control-allow-methods') || '', /DELETE/)
    }
    const register = async (username, NT, Department) => {
      const { response, body } = await request(base, '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'smoke-password', NT, Department }) })
      assert.equal(response.status, 201)
      assert.equal(typeof body.token, 'string')
      return body.token
    }
    const alice = await register('alice', 'Alice', 'Engineering')
    const bob = await register('bob', 'Bob', 'Sales')
    let result = await request(base, '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'duplicate-nt', password: 'smoke-password', NT: 'alice', Department: 'Other' }) })
    assert.equal(result.response.status, 409)
    assert.equal(result.body.error, 'NT 已存在')
    const bearer = (token) => ({ authorization: `Bearer ${token}` })
    result = await request(base, '/api/data/sessions', { method: 'POST', headers: { ...bearer(alice), 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, sessions: [{ id: 'alice-session', title: 'Alice only' }] }) })
    assert.equal(result.response.status, 200)
    result = await request(base, '/api/data/sessions', { headers: bearer(bob) })
    assert.deepEqual(result.body, { sessions: [], version: 0 })
    const templates = [{ id: 'meeting', name: 'Meeting', content: '# Summary' }]
    result = await request(base, '/api/data/summary-templates', { method: 'POST', headers: { ...bearer(alice), 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, templates, selectedTemplateId: 'meeting' }) })
    assert.deepEqual(result.body, { saved: true, version: 1 })
    result = await request(base, '/api/data/summary-templates', { headers: bearer(bob) })
    assert.deepEqual(result.body, { templates: [], selectedTemplateId: null, version: 0 })
    result = await request(base, '/api/data/summary-templates', { method: 'POST', headers: { ...bearer(alice), 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, templates, selectedTemplateId: 'meeting' }) })
    assert.equal(result.response.status, 409)
    result = await request(base, '/api/data/audio/alice-session', { method: 'POST', headers: { ...bearer(alice), 'content-type': 'audio/wav' }, body: Buffer.from('alice-audio') })
    assert.equal(result.response.status, 201)
    result = await request(base, '/api/data/audio/alice-session', { headers: bearer(bob) })
    assert.equal(result.response.status, 404)
    result = await request(base, '/api/voiceprints', { headers: bearer(alice) })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body.voiceprints, [])
    result = await request(base, '/api/voiceprints', { method: 'POST', headers: { ...bearer(alice), 'x-s2t-voiceprint-sharing': 'department' }, body: Buffer.from('not-a-wav') })
    assert.equal(result.response.status, 400)
    assert.match(result.body.error, /明確同意/)
    console.log('Gateway auth smoke test passed.')
  } finally {
    child.kill()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
