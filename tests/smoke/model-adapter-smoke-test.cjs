const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/models/model-adapter.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('model-adapter-smoke-module')
loaded.filename = 'model-adapter-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { OpenAiChunkedModelAdapter } = loaded.exports

const main = async () => {
  let keyChecks = 0
  global.window = { s2t: { hasModelApiKey: async () => { keyChecks += 1; return false } } }
  const noKey = new OpenAiChunkedModelAdapter({ id: 'local-asr', endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: 'local', requiresApiKey: false })
  await noKey.start({ sampleRate: 16_000, language: 'auto', targetLanguage: 'en' })
  assert.equal(keyChecks, 0, 'keyless models must not require a stored key')
  const requiresKey = new OpenAiChunkedModelAdapter({ id: 'protected-asr', endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: 'protected', requiresApiKey: true })
  await assert.rejects(requiresKey.start({ sampleRate: 16_000, language: 'auto', targetLanguage: 'en' }), /API key/)
  assert.equal(keyChecks, 1)
  const requests = []
  const transcripts = []
  global.window = { s2t: { transcribeAudioChunk: async (request) => { requests.push(request); return { text: '測試即時字幕' } } } }
  const live = new OpenAiChunkedModelAdapter({ id: 'live-test', endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: 'local', requiresApiKey: false })
  live.onTranscript((entry) => transcripts.push(entry))
  await live.start({ sampleRate: 48_000, language: 'zh-TW', targetLanguage: 'en' })
  for (let offset = 0; offset < 48_000 * 3; offset += 128) {
    live.pushAudio(Float32Array.from({ length: 128 }, (_, index) => .02 * Math.sin(2 * Math.PI * 180 * (offset + index) / 48_000)), offset)
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(requests.length > 0, 'ordinary microphone audio must reach ASR before recording stops')
  assert.ok(transcripts.some((entry) => entry.sourceText === '測試即時字幕'), 'ASR results must be emitted during capture')
  assert.equal(requests[0].prompt, undefined, 'the first chunk has no rolling context yet')
  await live.stop()
  assert.ok(requests.length >= 2, 'the final flush must send the remaining pending audio')
  assert.ok(String(requests[1].prompt || '').includes('測試即時字幕'), 'later chunks must carry the previous caption as rolling prompt')
  const shortEvents = []
  const short = new OpenAiChunkedModelAdapter({ id: 'short-test', endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: 'local', requiresApiKey: false, vadConfig: { minSpeechMs:120, minSilenceMs:250, preRollMs:300, noiseFloorOffsetDb:12, chunkMinMs:700, chunkMaxMs:1500 } })
  short.onTranscript(e=>shortEvents.push(e))
  await short.start({ sampleRate:16000, language:'zh-TW', targetLanguage:'en' })
  for(let offset=0;offset<8000;offset+=160) short.pushAudio(new Float32Array(160).fill(offset<3200?.1:0),offset)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(shortEvents.length,1,'a 200ms utterance is sent at its silence boundary without waiting for stop')
  assert.equal(shortEvents[0].isSentenceBoundary,true)
  await short.stop()
  const webRequests = []
  const webTranscripts = []
  const webErrors = []
  global.window = { setTimeout, clearTimeout }
  global.fetch = async (url, init) => {
    webRequests.push({ url, ...init })
    return new Response(JSON.stringify({ text: '網頁即時字幕' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }
  const web = new OpenAiChunkedModelAdapter({ id: 'web-asr', endpoint: '/api/transcriptions', model: 'local', gatewayProfileId: 'default' })
  web.onTranscript((entry) => webTranscripts.push(entry))
  web.onError((message) => webErrors.push(message))
  await web.start({ sampleRate: 48_000, language: 'zh-TW', targetLanguage: 'en' })
  for (let offset = 0; offset < 48_000 * 3; offset += 128) {
    web.pushAudio(Float32Array.from({ length: 128 }, (_, index) => .02 * Math.sin(2 * Math.PI * 180 * (offset + index) / 48_000)), offset)
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(webRequests.length > 0, 'web capture must send ASR requests during recording')
  assert.equal(webRequests[0].headers.authorization, undefined, 'Web authentication is carried by the HttpOnly cookie, not localStorage')
  assert.equal(webRequests[0].headers['x-s2t-model-id'], 'default')
  assert.equal(webRequests[0].headers['x-s2t-language'], 'zh')
  assert.ok(webTranscripts.some((entry) => entry.sourceText === '網頁即時字幕'), 'authenticated web ASR must emit live captions')
  await web.stop()
  assert.ok(webRequests.length >= 2, 'the web flush must send the remaining pending audio')
  assert.equal(webRequests[0].headers['x-s2t-prompt'], undefined, 'the first web chunk has no rolling context yet')
  assert.ok(decodeURIComponent(String(webRequests[1].headers['x-s2t-prompt'] || '')).includes('網頁即時字幕'), 'web chunks must carry the rolling prompt header')
  assert.deepEqual(webErrors, [])
  // Silero gate observability: vetoes report silero_veto and drop the chunk;
  // a failing gate fails open (chunk still transcribed) with silero_failed.
  const gate = { silero: [], asr: 0, telemetry: [] }
  global.window = { setTimeout, clearTimeout }
  global.fetch = async (url, init) => {
    const path = String(url)
    if (path.includes('/api/telemetry/captions')) { gate.telemetry.push(JSON.parse(init.body)); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }
    if (path.includes('/api/audio-processing/silero-vad')) {
      const reply = gate.silero.shift() || { status: 200, body: { speech: [] } }
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
    }
    gate.asr += 1
    return new Response(JSON.stringify({ text: '閘門字幕' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const pushSpeech = async (adapter) => {
    await adapter.start({ sampleRate: 48_000, language: 'zh-TW', targetLanguage: 'en' })
    for (let offset = 0; offset < 48_000 * 3; offset += 128) {
      adapter.pushAudio(Float32Array.from({ length: 128 }, (_, index) => .02 * Math.sin(2 * Math.PI * 180 * (offset + index) / 48_000)), offset)
    }
    await new Promise((resolve) => setImmediate(resolve))
    await adapter.stop()
  }
  const vetoTranscripts = []
  for (let chunk = 0; chunk < 8; chunk += 1) gate.silero.push({ status: 200, body: { speech: [] } })
  const veto = new OpenAiChunkedModelAdapter({ id: 'gate-veto', endpoint: '/api/transcriptions', model: 'local', gatewayProfileId: 'default', sileroVadEnabled: true })
  veto.onTranscript((entry) => vetoTranscripts.push(entry))
  await pushSpeech(veto)
  assert.equal(gate.asr, 0, 'vetoed chunks must not reach ASR')
  assert.equal(vetoTranscripts.length, 0, 'vetoed chunks must not emit captions')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok(gate.telemetry.some((payload) => (payload.events?.silero_veto || 0) >= 1), 'gate vetoes must report the silero_veto metric')
  gate.asr = 0
  gate.silero = []
  for (let chunk = 0; chunk < 8; chunk += 1) gate.silero.push({ status: 500, body: { error: 'silero-down' } })
  const failOpenErrors = []
  const failOpenTranscripts = []
  const failOpen = new OpenAiChunkedModelAdapter({ id: 'gate-fail-open', endpoint: '/api/transcriptions', model: 'local', gatewayProfileId: 'default', sileroVadEnabled: true })
  failOpen.onTranscript((entry) => failOpenTranscripts.push(entry))
  failOpen.onError((message) => failOpenErrors.push(message))
  await pushSpeech(failOpen)
  assert.ok(gate.asr > 0, 'a failing gate must fail open instead of losing chunks')
  assert.ok(failOpenTranscripts.some((entry) => entry.sourceText === '閘門字幕'), 'fail-open chunks must still be transcribed')
  assert.ok(failOpenErrors.length > 0, 'the gate failure must surface to the user')
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.ok(gate.telemetry.some((payload) => (payload.events?.silero_failed || 0) >= 1), 'gate failures must report the silero_failed metric')
  console.log('Model adapter smoke test passed.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
