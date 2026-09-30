// Commit-grace smoke: an uploaded-but-not-yet-committed audio blob must
// survive reconciliation triggered by an unrelated session save, and must
// still be cleaned up once the grace window has passed.
//
// Before the fix, POST /api/data/sessions (from any tab) deleted audio that
// was uploaded moments earlier but not yet referenced by any session, leaving
// the imminent commit pointing at a 404.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const port = Number(process.env.S2T_GRACE_SMOKE_PORT || 8797)
const base = `http://127.0.0.1:${port}`
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const probe = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* keep raw text */ }
  return { status: response.status, body }
}

const main = async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 's2t-grace-smoke-'))
  const audioId = `grace-${randomUUID()}`
  let child = null
  try {
    child = spawn(process.execPath, ['server/index.cjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        S2T_WEB_PORT: String(port),
        S2T_WEB_ORIGINS: 'http://127.0.0.1:5173',
        S2T_LOCAL_DATA_DIR: dataDirectory,
        // Short grace keeps the test fast; the window logic is identical.
        S2T_STORAGE_COMPENSATION_GRACE_MS: '3000',
        S2T_BOOTSTRAP_ADMIN_USERNAME: '', S2T_BOOTSTRAP_ADMIN_PASSWORD: '',
        S2T_MINIO_ENDPOINT: '', S2T_MINIO_BUCKET: '', S2T_MINIO_ACCESS_KEY: '', S2T_MINIO_SECRET_KEY: '',
        S2T_POSTGRES_HOST: '', S2T_POSTGRES_PORT: '', S2T_POSTGRES_DB_NAME: '', S2T_POSTGRES_USER: '', S2T_POSTGRES_PASSWORD: '',
        S2T_MILVUS_ENDPOINT: '', S2T_MILVUS_DB_NAME: '', S2T_MILVUS_COLLECTION: '', S2T_MILVUS_TOKEN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const exitState = { value: null }
    child.on('exit', (code, signal) => { exitState.value = { code, signal } })

    let up = false
    for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
      if (exitState.value) assert.fail(`gateway exited early:\n${output}`)
      up = (await probe('/livez').catch(() => ({ status: 0 }))).status === 200
      if (!up) await delay(250)
    }
    assert.equal(up, true, `gateway did not start:\n${output}`)

    const registration = await probe('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `grace-${randomUUID().replace(/-/g, '').slice(0, 12)}`, password: 'grace-smoke-password', NT: `Grace ${randomUUID().replace(/-/g, '').slice(0, 10)}`, Department: 'Storage smoke' })
    })
    assert.equal(registration.status, 201, JSON.stringify(registration.body))
    const auth = { authorization: `Bearer ${registration.body.token}` }

    const grace = Number((await probe('/api/storage')).body?.compensationGraceMs)
    assert.equal(grace, 3000, 'gateway must honour S2T_STORAGE_COMPENSATION_GRACE_MS and report it on /api/storage')

    const upload = await probe(`/api/data/audio/${audioId}`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/wav' }, body: Buffer.from('grace smoke audio') })
    assert.equal(upload.status, 201, JSON.stringify(upload.body))

    // An unrelated session save triggers reconciliation. The fresh upload is
    // not referenced by it yet — it must not be deleted.
    const save = await probe('/api/data/sessions', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, sessions: [{ id: `session-${randomUUID()}`, title: 'Grace smoke', audioKey: 'unrelated-key' }] }) })
    assert.equal(save.status, 200, JSON.stringify(save.body))

    const status = await probe('/api/data/storage-status', { headers: auth })
    assert.deepEqual(status.body, { audioPending: 1, voiceprintPending: 0 })
    const stillThere = await probe(`/api/data/audio/${audioId}`, { headers: auth })
    assert.equal(stillThere.status, 200, 'a fresh upload must survive reconciliation before its session commit')

    // After the grace window the same intent becomes eligible again, so
    // abandoned uploads are still cleaned up.
    await delay(grace + 500)
    const retry = await probe('/api/data/storage-retry', { method: 'POST', headers: auth })
    assert.deepEqual(retry.body, { retried: true, audioPending: 0, voiceprintPending: 0 }, JSON.stringify(retry.body))
    const gone = await probe(`/api/data/audio/${audioId}`, { headers: auth })
    assert.equal(gone.status, 404, 'an unreferenced upload must still be cleaned up after the grace window')

    assert.equal(exitState.value, null, `gateway crashed during the test: ${JSON.stringify(exitState.value)}\n${output}`)
    console.log('Storage commit grace smoke test passed.')
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    await rm(dataDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
