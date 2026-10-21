const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, writeFile, rm, readFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const jwt = require('jsonwebtoken')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  const root = await mkdtemp(join(tmpdir(), 's2t-500-latency-'))
  let active = 0, peak = 0, calls = 0, child
  const model = createServer(async (request, response) => {
    for await (const chunk of request) { /* consume WAV/JSON before model timer */ }
    active++; peak = Math.max(peak, active); calls++
    await delay(500); active--
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url.includes('/audio/') ? { text: 'load test caption', language: 'en' } : { choices: [{ message: { content: '測試字幕' } }] }))
  })
  try {
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    const secret = 'isolated-performance-benchmark-secret'
    const env = { ...process.env }
    const dotenv = require('dotenv').parse(await readFile('.env').catch(() => Buffer.alloc(0)))
    for (const key of new Set([...Object.keys(env), ...Object.keys(dotenv)])) if (key.startsWith('S2T_') || key.startsWith('REDIS_')) env[key] = ''
    Object.assign(env, {
      S2T_WEB_PORT: String(port), S2T_AUTH_SECRET: secret, S2T_ALLOW_DEFAULT_ADMIN: 'true', S2T_DATA_DIR: root, S2T_LOG_LEVEL: 'error',
      S2T_ASR_ENDPOINT: `http://127.0.0.1:${model.address().port}/v1`, S2T_ASR_MODEL: 'fixture', S2T_ASR_API_KEY: 'fixture', S2T_ASR_MAX_INFLIGHT: '256', S2T_TRANSLATION_MAX_INFLIGHT: '256',
      S2T_TRANSLATION_ENDPOINT: `http://127.0.0.1:${model.address().port}/v1`, S2T_TRANSLATION_MODEL: 'fixture', S2T_TRANSLATION_API_KEY: 'fixture', S2T_SHUTDOWN_GRACE_MS: '2000'
    })
    child = spawn(process.execPath, ['tests/helpers/performance-gateway.cjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(output)
      if (await fetch(`${base}/readyz`).then(response => response.ok, () => false)) { ready = true; break }
      await delay(50)
    }
    assert.ok(ready, output)
    const tokens = join(root, 'tokens.json'), wav = join(root, 'speech.wav')
    await writeFile(tokens, JSON.stringify(Array.from({ length: 500 }, (_, i) => jwt.sign({ sub: `load_${i}`, jti: `load-token-${i}` }, secret, { expiresIn: '1h' }))))
    // Two-second PCM16 mono request: realistic upload bytes, synthetic content.
    const audio = Buffer.alloc(64044); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(64000, 40)
    await writeFile(wav, audio)
    let report
    try {
      const result = await promisify(execFile)(process.execPath, ['scripts/benchmarks/gateway-load-test.cjs'], { env: { ...env, S2T_LOAD_BASE_URL: base, S2T_LOAD_TOKENS_FILE: tokens, S2T_LOAD_WAV: wav, S2T_LOAD_CONCURRENCY: '500', S2T_LOAD_DURATION_SECONDS: '1', S2T_LOAD_INTERVAL_MS: '1000', S2T_LOAD_ARRIVAL_MODE: 'burst', S2T_LOAD_MAX_P95_MS: '3000' }, maxBuffer: 2 ** 20 })
      report = JSON.parse(result.stdout)
    } catch (error) { console.error(error.stdout, output); throw error }
    assert.equal(report.offered, 500); assert.equal(report.distinctTokens, 500); assert.equal(report.gatewayChain.successful, 500)
    assert.equal(calls, 1000); assert.equal(report.sloPassed, true)
    assert.ok(peak > 100, 'model requests must execute concurrently')
    console.log(JSON.stringify({ ...report, peakModelConcurrency: peak, note: 'Real single gateway HTTP/auth/routes/OpenAI SDK, 500 distinct accounts; model fixed 500ms, storage in memory. Real Sentinel admission code at 256 per model; Redis/storage simulated. External PG/Sentinel/MinIO and browser/network not included.' }, null, 2))
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
