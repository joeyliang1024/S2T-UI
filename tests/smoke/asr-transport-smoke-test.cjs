const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const code = buildSync({ stdin: { contents: `export * from './src/renderer/src/features/models/adapters/openai-chunked'; export * from './src/renderer/src/features/models/transports/web-asr'; export * from './src/renderer/src/features/models/transports/desktop-asr'; export * from './src/renderer/src/shared/http/authenticated-client';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',code)(m,m.exports,require)
const { OpenAiChunkedModelAdapter, createWebAsrTransport, createDesktopAsrTransport, setAccessToken, setAuthenticatedUser } = m.exports
const profile = { id: 'fixture', endpoint: '/api/transcriptions', model: 'fixture', gatewayProfileId: 'fixture', requiresApiKey: false }
;(async () => {
  global.window = { setTimeout, clearTimeout }
  let calls = 0
  const injected = { ensureReady: async () => {}, hasSpeech: async () => true, transcribe: async request => { calls++; assert.equal(request.language, 'en'); throw new DOMException('account changed', 'AbortError') } }
  const adapter = new OpenAiChunkedModelAdapter(profile, injected)
  await adapter.start({ sampleRate: 16000, language: 'en', targetLanguage: 'zh-TW' })
  await assert.rejects(adapter.transcribeWithRetry(new ArrayBuffer(44)), { name: 'AbortError' })
  assert.equal(calls, 1, 'cancellation is never retried')
  let ipc, keyChecks = 0
  const desktopProfile = { ...profile }
  const desktop = createDesktopAsrTransport(desktopProfile, { hasModelApiKey: async () => { keyChecks++; return false }, transcribeAudioChunk: async request => { ipc = request; return { text: 'desktop' } } })
  desktopProfile.model = 'changed after binding'
  await desktop.ensureReady(); assert.equal(keyChecks, 0)
  await desktop.transcribe({ audio: new ArrayBuffer(44), key: 'request-1', language: 'en', prompt: 'context' })
  assert.equal(ipc.model, 'fixture'); assert.equal(ipc.requiresApiKey, false); assert.equal(ipc.prompt, 'context')
  const canceled = new AbortController(); canceled.abort()
  await assert.rejects(desktop.transcribe({ audio: new ArrayBuffer(44), key: 'request-2', language: 'en', signal: canceled.signal }), { name: 'AbortError' })
  setAccessToken('user-a')
  await assert.rejects(desktop.transcribe({ audio: new ArrayBuffer(44), key: 'old-desktop', language: 'en' }), { name: 'AbortError' })
  let wireCalls = 0, release
  const web = createWebAsrTransport(profile, async (_url, init) => { wireCalls++; assert.equal(new Headers(init.headers).get('x-s2t-idempotency-key'), 'stable-key'); return new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ text: 'old-account' }), { headers: { 'content-type': 'application/json' } })) }) })
  const pending = web.transcribe({ audio: new ArrayBuffer(44), key: 'stable-key', language: 'en' })
  setAccessToken('user-b'); release()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(web.transcribe({ audio: new ArrayBuffer(44), key: 'stable-key', language: 'en' }), { name: 'AbortError' })
  assert.equal(wireCalls, 1, 'transport cannot reuse old capture with a new account')
  setAccessToken(''); const controller = new AbortController()
  const cancellable = createWebAsrTransport(profile, async (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException('canceled', 'AbortError'))) }))
  const request = cancellable.transcribe({ audio: new ArrayBuffer(44), key: 'cancel', language: 'en', signal: controller.signal })
  controller.abort(); await assert.rejects(request, { name: 'AbortError' })
  await assert.rejects(cancellable.transcribe({ audio: new ArrayBuffer(44), key: 'already-cancelled', language: 'en', signal: controller.signal }), { name: 'AbortError' })
  setAuthenticatedUser('cookie-user-a')
  const cookieBound = createWebAsrTransport(profile, async () => { throw Error('stale cookie account request must never send') })
  setAuthenticatedUser('cookie-user-b')
  await assert.rejects(cookieBound.transcribe({ audio: new ArrayBuffer(44), key: 'cookie-switch', language: 'en' }), { name: 'AbortError' })
  console.log('PASS injected adapter, cancellation without retry, immutable desktop binding, keyless IPC and account-fenced Web results/requests')
})().catch(error => { console.error(error); process.exitCode = 1 })
