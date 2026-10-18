const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const code = buildSync({ stdin: { contents: "export * from './src/renderer/src/features/translation/transports/web-text'; export * from './src/renderer/src/features/translation/transports/desktop-text'; export * from './src/renderer/src/shared/http/authenticated-client';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',code)(m,m.exports,require)
const { createWebTextPort, createDesktopTextPort, setAuthenticatedUser } = m.exports
const binding = { id: 'custom', endpoint: 'http://fixture/v1', model: 'fixture', requiresApiKey: false }
const input = { text: 'hello', sourceLanguage: 'en-US', targetLanguage: 'ja', glossary: 'hello=こんにちは', temperature: .25 }
const clock = () => { let callback, duration; return { count: 0, setTimeout(fn, ms) { callback = fn; duration = ms; this.count++; return 1 }, clearTimeout() { this.count-- }, fire() { callback() }, get duration() { return duration } } }
;(async () => {
  const timer = clock(); let wire
  const web = createWebTextPort(binding, { clock: timer, fetch: async (url, options) => { wire = { url, options }; return new Response(JSON.stringify({ text: 'こんにちは' }), { headers: { 'server-timing': 'translation_model;dur=20' } }) } })
  assert.equal((await web.complete(input)).text, 'こんにちは')
  assert.equal(timer.duration, 15000); assert.equal(timer.count, 0)
  assert.equal(JSON.parse(wire.options.body).temperature, .25); assert.equal(JSON.parse(wire.options.body).glossary, input.glossary)
  assert.equal(new Headers(wire.options.headers).get('x-s2t-model-id'), 'custom'); assert.ok(new Headers(wire.options.headers).get('x-s2t-idempotency-key'))
  const firstKey = wire.options.headers['x-s2t-idempotency-key']; await web.complete({ ...input, format: 'markdown' })
  assert.equal(timer.duration, 90000); assert.equal(JSON.parse(wire.options.body).format, 'markdown'); assert.notEqual(wire.options.headers['x-s2t-idempotency-key'], firstKey)
  const abort = new AbortController(); abort.abort()
  const noWire = createWebTextPort(binding, { clock: timer, fetch: async () => { throw Error('must not send') } })
  await assert.rejects(noWire.complete({ ...input, signal: abort.signal }), { name: 'AbortError' })
  const desktopClock = clock(); let request, cancelId
  const desktop = createDesktopTextPort(binding, { completeText: async value => { request = value; return { text: 'desktop' } }, cancelCompleteText: async id => { cancelId = id } }, desktopClock)
  await desktop.complete(input); assert.equal(request.requiresApiKey, false); assert.equal(request.temperature, .25); assert.match(request.messages[0].content, /hello=こんにちは/)
  const cancel = new AbortController()
  const pending = createDesktopTextPort(binding, { completeText: value => { request = value; return new Promise(() => {}) }, cancelCompleteText: async id => { cancelId = id } }, desktopClock)
  const waiting = pending.complete({ ...input, signal: cancel.signal }); cancel.abort()
  await assert.rejects(waiting, { name: 'AbortError' }); await Promise.resolve(); assert.equal(cancelId, request.requestId); assert.equal(desktopClock.count, 0)
  setAuthenticatedUser('text-a'); let release
  const stale = createWebTextPort(binding, { clock: timer, fetch: async () => new Promise(resolve => { release = () => resolve(new Response(JSON.stringify({ text: 'old' }))) }) })
  const old = stale.complete(input); setAuthenticatedUser('text-b'); release()
  await assert.rejects(old, { name: 'AbortError' }); await assert.rejects(stale.complete(input), { name: 'AbortError' }); assert.equal(timer.count, 0)
  console.log('PASS text ports: plain/Markdown deadlines, glossary/temperature/keyless IPC, request keys, cancellation ID and account-fenced requests/results')
})().catch(error => { console.error(error); process.exitCode = 1 })
