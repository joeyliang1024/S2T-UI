const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')
const { mkdtemp, rm, readFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { once } = require('node:events')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  const root = await mkdtemp(join(tmpdir(), 's2t-http-scale-'))
  const children = []
  let calls = 0, upstreamStarted
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) { /* drain */ }
    calls++; upstreamStarted?.()
    await delay(250)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: 'caption', language: 'en' }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  try {
    const inherited = { ...process.env }
    const dotenv = require('dotenv')
    const fileEnv = dotenv.parse(await readFile('.env').catch(() => Buffer.alloc(0)))
    for (const key of new Set([...Object.keys(inherited), ...Object.keys(fileEnv)])) if (key.startsWith('S2T_')) inherited[key] = ''
    const start = async (overrides = {}) => {
      const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
      const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
      const child = spawn(process.execPath, ['server/index.cjs'], { env: { ...inherited, S2T_WEB_PORT: String(port), S2T_LOCAL_DATA_DIR: root, S2T_AUTH_SECRET: 'isolated-http-test-secret', S2T_ASR_ENDPOINT: `http://127.0.0.1:${upstream.address().port}/v1`, S2T_ASR_MODEL: 'test', S2T_ASR_API_KEY: 'test', S2T_SHUTDOWN_GRACE_MS: '2000', S2T_STORAGE_COMPENSATION_GRACE_MS: '150', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
      children.push(child)
      const base = `http://127.0.0.1:${port}`
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(output)
        if (await fetch(`${base}/readyz`).then(response => response.ok, () => false)) return { child, base }
        await delay(50)
      }
      throw new Error(`Startup failed: ${output}`)
    }
    const one = await start(), two = await start()
    const login = await fetch(`${one.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })
    assert.equal(login.status, 200)
    const { token } = await login.json(), auth = { authorization: `Bearer ${token}` }
    const pcm = Buffer.from([1, 0, 2, 0])
    const append = (base, index, start) => fetch(`${base}/api/data/recordings/http-capture/chunks/${index}`, { method: 'PUT', headers: { ...auth, 'x-s2t-start-sample': String(start), 'x-s2t-sample-rate': '16000' }, body: pcm })
    assert.equal((await append(one.base, 0, 0)).status, 200)
    assert.equal((await append(two.base, 1, 2)).status, 200)
    const finish = await fetch(`${two.base}/api/data/recordings/http-capture/finish`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ totalChunks: 2, totalSamples: 4 }) })
    assert.equal(finish.status, 200)
    const audit = await fetch(`${one.base}/api/data/storage-audit`, { headers: auth }).then(response => response.json())
    assert.equal(audit.orphanAudio, 0, 'completed recording backup must survive storage audit')
    const promote = await fetch(`${one.base}/api/data/recordings/http-capture/promote`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ audioKey: 'formal-capture' }) })
    assert.equal(promote.status, 201)
    const promoted = await fetch(`${two.base}/api/data/audio/formal-capture`, { headers: auth }).then(response => response.arrayBuffer())
    assert.deepEqual(Buffer.from(promoted).subarray(44), Buffer.concat([pcm, pcm]))
    const deletion = await fetch(`${two.base}/api/data/recordings/http-capture`, { method: 'DELETE', headers: auth })
    assert.equal(deletion.status, 204)
    assert.equal((await fetch(`${one.base}/api/data/recordings/http-capture`, { headers: auth })).status, 404)
    assert.equal((await fetch(`${one.base}/api/data/audio/formal-capture`, { headers: auth })).status, 200)

    const audio = await fetch(`${one.base}/api/data/audio/formal-capture`, { headers: auth }).then(response => response.arrayBuffer())
    assert.deepEqual(Buffer.from(audio).subarray(44), Buffer.concat([pcm, pcm]))
    const commit = await fetch(`${one.base}/api/data/sessions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, sessions: [{ id: 'formal-session', audioKey: 'formal-capture' }] }) })
    assert.equal(commit.status, 200)
    const { Readable } = require('node:stream')
    const slowBody = Readable.from((async function* () { yield Buffer.from(audio).subarray(0, 24); await delay(600); yield Buffer.from(audio).subarray(24) })())
    const slowUpload = fetch(`${one.base}/api/data/audio/slow-upload`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/wav' }, body: slowBody, duplex: 'half' })
    await delay(300) // Longer than commit grace, while the upload is still active.
    const retry = await fetch(`${two.base}/api/data/storage-retry`, { method: 'POST', headers: auth }).then(response => response.json())
    assert.equal(retry.audioPending, 1, 'active streaming upload must remain protected beyond commit grace')
    assert.equal((await slowUpload).status, 201)
    assert.equal((await fetch(`${two.base}/api/data/audio/slow-upload`, { headers: auth })).status, 200)
    const headers = { ...auth, 'content-type': 'audio/wav', 'x-s2t-idempotency-key': 'http-segment' }
    assert.equal((await fetch(`${one.base}/api/transcriptions`, { method: 'POST', headers, body: Buffer.from(audio) })).status, 200)
    assert.equal((await fetch(`${two.base}/api/transcriptions`, { method: 'POST', headers, body: Buffer.from(audio) })).status, 200)
    assert.equal(calls, 1, 'HTTP retry on another gateway must reuse durable result')
    assert.equal((await fetch(`${two.base}/api/transcriptions`, { method: 'POST', headers, body: pcm })).status, 409)
    let started
    const waiting = new Promise(resolve => { started = resolve })
    upstreamStarted = started
    const pending = fetch(`${one.base}/api/transcriptions`, { method: 'POST', headers: { ...headers, 'x-s2t-idempotency-key': 'drain-segment' }, body: Buffer.from(audio) })
    await waiting
    const exit = once(one.child, 'exit')
    one.child.kill('SIGTERM')
    const drainedResponse = await pending
    assert.equal(drainedResponse.status, 200, 'SIGTERM must allow active HTTP work to complete')
    assert.equal((await drainedResponse.json()).text, 'caption')
    const [code] = await exit; assert.equal(code, 0)
    const service = await start({ S2T_PROCESS_ROLE: 'audio-service', S2T_AUDIO_SERVICE_TOKEN: 'private-test-token', S2T_LOCAL_DATA_DIR: join(root, 'service') })
    const unauthorized = await fetch(`${service.base}/internal/audio/audioPreprocessStatus`, { method: 'POST', body: '[]' })
    assert.equal(unauthorized.status, 401)
    const { createAudioClient } = require('../../server/audio-service.cjs')
    const audioClient = createAudioClient({ S2T_PROCESS_ROLE: 'api', S2T_AUDIO_SERVICE_URL: service.base, S2T_AUDIO_SERVICE_TOKEN: 'private-test-token' })
    const status = await audioClient.audioPreprocessStatus()
    assert.ok(status.sileroVad)
    const output = await audioClient.transcodeM4a(Buffer.from(audio))
    assert.ok(Buffer.isBuffer(output)); assert.ok(output.length > 0)
    const publicApi = await fetch(`${service.base}/api/config`)
    assert.equal(publicApi.status, 401)
    console.log('PASS: unchanged standalone startup, two gateway processes, durable chunk handoff, HTTP replay, content conflict and SIGTERM request drain. No external model calls.')
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    await new Promise(resolve => upstream.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
