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
  await live.stop()
  const webRequests = []
  const webTranscripts = []
  const webErrors = []
  global.window = { localStorage: { getItem: () => 'test-session-token' }, setTimeout }
  global.fetch = async (url, init) => {
    webRequests.push({ url, ...init })
    const authorized = init.headers.authorization === 'Bearer test-session-token'
    return new Response(JSON.stringify(authorized ? { text: '網頁即時字幕' } : { error: '需要登入' }), {
      status: authorized ? 200 : 401, headers: { 'content-type': 'application/json' }
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
  assert.equal(webRequests[0].headers.authorization, 'Bearer test-session-token', 'ASR must carry the login token')
  assert.equal(webRequests[0].headers['x-s2t-model-id'], 'default')
  assert.equal(webRequests[0].headers['x-s2t-language'], 'zh')
  assert.ok(webTranscripts.some((entry) => entry.sourceText === '網頁即時字幕'), 'authenticated web ASR must emit live captions')
  await web.stop()
  assert.deepEqual(webErrors, [])
  console.log('Model adapter smoke test passed.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
