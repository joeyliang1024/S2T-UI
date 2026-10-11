// Explicit synthetic acceptance traffic; no production accounts, storage or APIs.
const { createServer } = require('node:http')
const { spawn } = require('node:child_process')
const { mkdtemp } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const aliases = new Map()
let ready = false, tick = 0, child
const mock = createServer(async (request, response) => {
  for await (const ignored of request) void ignored
  await sleep(80 + tick % 5 * 40)
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(request.url.includes('transcriptions') ? { text: '驗收模擬字幕', language: 'zh' } : { choices: [{ message: { content: 'Acceptance mock output only.' } }], ...(tick % 11 ? { usage: { prompt_tokens: 40 + tick % 20, completion_tokens: 12 + tick % 8 } } : {}) }))
})
const exporter = createServer(async (request, response) => {
  if (request.url === '/healthz') { response.statusCode = ready ? 200 : 503; return response.end(ready ? 'ready' : 'starting') }
  if (request.url !== '/metrics') { response.statusCode = 404; return response.end() }
  try {
    let text = await (await fetch('http://127.0.0.1:8878/metrics')).text()
    for (const [id, alias] of aliases) text = text.replaceAll(`user_id=${JSON.stringify(id)}`, `user_id=${JSON.stringify(alias)}`)
    response.setHeader('content-type', 'text/plain; version=0.0.4'); response.end(text)
  } catch { response.statusCode = 503; response.end('starting') }
})
;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-monitoring-acceptance-'))
  await new Promise(resolve => mock.listen(18888, '127.0.0.1', resolve))
  await new Promise(resolve => exporter.listen(8787, '0.0.0.0', resolve))
  child = spawn(process.execPath, ['/app/server/index.cjs'], { cwd: directory, env: { PATH: process.env.PATH, S2T_LOCAL_DATA_DIR: directory, S2T_AUTH_SECRET: 'synthetic-acceptance-only-secret', S2T_WEB_PORT: '8878', S2T_PROCESS_ROLE: 'api', S2T_BOOTSTRAP_ADMIN_USERNAME: 'acceptance-admin', S2T_BOOTSTRAP_ADMIN_PASSWORD: 'acceptance-only', S2T_ASR_ENDPOINT: 'http://127.0.0.1:18888/v1', S2T_ASR_MODEL: 'acceptance-mock', S2T_ASR_API_KEY: 'acceptance-only', S2T_TRANSLATION_ENDPOINT: 'http://127.0.0.1:18888/v1', S2T_TRANSLATION_MODEL: 'acceptance-mock', S2T_TRANSLATION_API_KEY: 'acceptance-only', S2T_SUMMARY_ENDPOINT: 'http://127.0.0.1:18888/v1', S2T_SUMMARY_MODEL: 'acceptance-mock', S2T_SUMMARY_API_KEY: 'acceptance-only', S2T_ASR_REQUESTS_PER_MINUTE: '600', S2T_TRANSLATION_REQUESTS_PER_MINUTE: '600', S2T_LOG_LEVEL: 'error' }, stdio: ['ignore', 'inherit', 'inherit'] })
  child.on('exit', code => { if (code !== null) process.exit(code || 1) })
  const call = async (path, token, body, contentType = 'application/json') => {
    const response = await fetch('http://127.0.0.1:8878' + path, { method: 'POST', headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: contentType === 'application/json' ? JSON.stringify(body) : body })
    return { status: response.status, body: await response.json() }
  }
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:8878/readyz')).ok) break } catch {} await sleep(100) }
  const accounts = []
  for (const [index,name] of ['alice', 'bob', 'charlie'].entries()) {
    const result = await call('/api/auth/register', null, { username: 'acceptance-' + name, password: 'acceptance-only', NT: ['驗收使用者甲', '驗收使用者乙', '驗收使用者丙'][index], Department: ['驗收研發部', '驗收研發部', '驗收營運部'][index] })
    if (result.status !== 201) throw Error('Acceptance account setup failed')
    accounts.push(result.body.token); aliases.set(result.body.user.id, 'DEMO-' + name)
  }
  ready = true
  const wav = Buffer.alloc(44 + 32000); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40)
  // Establish scrape baselines before generating the first request cohort.
  await sleep(10000)
  for (;;) {
    tick++
    for (let i = 0; i < accounts.length; i++) {
      if (tick % (i + 1)) continue
      const token = accounts[i]
      await call('/api/transcriptions', token, wav, 'audio/wav')
      await call('/api/translations', token, { text: 'Synthetic acceptance input ' + 'sample '.repeat((i + 1) * 3), sourceLanguage: 'en-US', targetLanguage: 'zh-TW' })
      if (i === 2) await call('/api/summaries', token, { messages: [{ role: 'user', content: 'Summarize this synthetic acceptance input only.' }] })
      if (tick % 5 === 0) await call('/api/translations', token, { text: '' })
      const seconds = [.12, .65 + i * .3, .05 + tick % 3 * .04, .03, .25 + i * .12, .025]
      const names = ['vad_onset', 'chunk_wait', 'browser_queue', 'browser_preprocess', 'asr_roundtrip_with_retries', 'response_to_paint']
      await call('/api/telemetry/captions', token, { samples: [{ stage: 'chunk_speech_to_paint', seconds: seconds.reduce((a, b) => a + b, 0) }, ...names.map((stage, index) => ({ stage: 'chunk_' + stage, seconds: seconds[index] })), { stage: 'response_to_paint', seconds: seconds[5] }, { stage: 'asr_roundtrip_with_retries', seconds: seconds[4] }], events: { speech_detected: 1 } })
    }
    await sleep(3000)
  }
})().catch(error => { console.error(error); child?.kill('SIGTERM'); process.exit(1) })
process.on('SIGTERM', () => { child?.kill('SIGTERM'); process.exit(0) })
