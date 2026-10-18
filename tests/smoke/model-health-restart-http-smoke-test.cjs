const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-model-restart-'))
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
  })
  await new Promise(done => upstream.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`
  let child, base, token
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    const exit = new Promise(done => child.once('exit', done))
    child.kill('SIGTERM'); await exit
  }
  const start = async secret => {
    const reserve = createServer(); await new Promise(done => reserve.listen(0, '127.0.0.1', done))
    const port = reserve.address().port; await new Promise(done => reserve.close(done))
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [resolve('server/index.cjs')], { cwd: directory, env: {
      PATH: process.env.PATH, S2T_WEB_PORT: String(port), S2T_LOCAL_DATA_DIR: directory,
      S2T_AUTH_SECRET: secret, S2T_BOOTSTRAP_ADMIN_USERNAME: 'admin', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'fixture-password',
      S2T_PROCESS_ROLE: 'api', S2T_LOG_LEVEL: 'silent'
    }, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''; child.stdout.on('data', bytes => { logs += bytes }); child.stderr.on('data', bytes => { logs += bytes })
    const deadline = Date.now() + 15000
    while (true) {
      try { if ((await fetch(base + '/readyz')).ok) break } catch {}
      if (child.exitCode !== null || Date.now() > deadline) throw Error(`gateway startup failed: ${logs}`)
      await new Promise(done => setTimeout(done, 50))
    }
    token = (await request('/api/auth/login', 'POST', { username: 'admin', password: 'fixture-password' })).body.token
    assert.ok(token)
  }
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token || ''}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  const health = async () => {
    const result = await request('/api/data/model-health', 'POST')
    assert.equal(result.status, 200, 'one failing model must not fail the entire batch')
    return Object.fromEntries(result.body.health.map(item => [item.id, item]))
  }
  const models = ['asr', 'translation', 'summary', 'diarization', 'embedding'].map(purpose => ({ id: `custom-${purpose}`, name: purpose, purpose, endpoint, model: 'fixture-model', requiresApiKey: true }))
  models.push({ ...models[0], id: 'keyless', requiresApiKey: false })
  try {
    await start('fixture-stable-secret')
    assert.equal((await request('/api/data/model-registry', 'POST', { models, version: 0 })).status, 200)
    assert.equal((await health())['custom-asr'].state, 'unknown')
    for (const model of models.filter(item => item.requiresApiKey)) {
      assert.equal((await request(`/api/data/model-credentials/${model.id}`, 'POST', { apiKey: 'fixture-upstream-key' })).status, 204)
    }
    let states = await health()
    for (const model of models) assert.equal(states[model.id].state, 'healthy', model.id)
    await stop(); await start('fixture-stable-secret')
    assert.deepEqual((await request('/api/data/model-registry')).body.models.map(item => item.id), models.map(item => item.id))
    states = await health()
    for (const model of models) assert.equal(states[model.id].state, 'healthy', `${model.id} survives restart`)
    await stop(); await start('fixture-changed-secret')
    states = await health()
    assert.equal(states.keyless.state, 'healthy')
    assert.equal(states['custom-asr'].state, 'unhealthy')
    assert.match(states['custom-asr'].reason, /S2T_AUTH_SECRET/)
    await request('/api/data/model-credentials/custom-asr', 'POST', { apiKey: 'fixture-replacement-key' })
    assert.equal((await health())['custom-asr'].state, 'healthy', 're-saving a key invalidates stale health immediately')
    console.log('PASS custom models: all purposes and encrypted credentials survive restart; changed secret isolates failures; re-saved keys clear stale health')
  } finally { await stop(); await new Promise(done => upstream.close(done)); await rm(directory, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
