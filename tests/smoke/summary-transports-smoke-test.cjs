const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const source = `export * from './src/renderer/src/features/summary/transports/web-summary'; export * from './src/renderer/src/features/summary/transports/desktop-summary'; export * from './src/renderer/src/features/summary/services/summarize-transcript'; export * from './src/renderer/src/shared/http/authenticated-client';`
const code = buildSync({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',code)(m,m.exports,require)
const { createWebSummaryPort, createDesktopSummaryPort, summarizeTranscript, setAuthenticatedUser } = m.exports
const profile = { endpoint: '/api/summaries', model: 'fixture', requiresApiKey: false }
const messages = [{ role: 'user', content: 'fixture' }]
const clock = () => { const tasks = new Map(); let next = 0; return { tasks, setTimeout(fn) { tasks.set(++next, fn); return next }, clearTimeout(id) { tasks.delete(id) }, fire() { for (const fn of [...tasks.values()]) fn() } } }
;(async () => {
  const plainClock = clock(); let wire
  const plain = createWebSummaryPort(profile, { clock: plainClock, fetch: async (url, options) => { wire = { url, options }; return new Response(JSON.stringify({ text: 'plain' })) } })
  assert.equal((await plain.complete({ messages, singleAttempt: true })).text, 'plain')
  assert.deepEqual(JSON.parse(wire.options.body), { messages, singleAttempt: true, stream: false }); assert.equal(plainClock.tasks.size, 0)
  const streamClock = clock(), updates = []; let streamCanceled = false
  const encoder = new TextEncoder()
  const streaming = createWebSummaryPort(profile, { clock: streamClock, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('{"delta":"摘要"}\n{"delta":"內容"}\n{"done":true}\n')); }, cancel() { streamCanceled = true } }), { headers: { 'content-type': 'application/x-ndjson' } }) })
  assert.equal((await streaming.complete({ messages, onText: text => updates.push(text) })).text, '摘要內容')
  assert.deepEqual(updates, ['摘要','摘要內容']); assert.equal(streamClock.tasks.size, 0); assert.equal(streamCanceled, true, 'done ends consumption and cancels a body that stays open')
  const timeoutClock = clock()
  const timeout = createWebSummaryPort(profile, { clock: timeoutClock, fetch: async () => new Response('', { headers: { 'content-type': 'application/x-ndjson' } }), readStream: async () => { assert.equal(timeoutClock.tasks.size, 1, 'deadline covers stream consumption'); timeoutClock.fire(); throw Error('signal is aborted without reason') } })
  await assert.rejects(timeout.complete({ messages, onText: () => {} }), /(?:timeout|timed out|逾時|超時)/i); assert.equal(timeoutClock.tasks.size, 0)
  const abort = new AbortController(), cancelClock = clock()
  const cancellable = createWebSummaryPort(profile, { clock: cancelClock, fetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('canceled','AbortError')))) })
  const canceled = cancellable.complete({ messages, signal: abort.signal }); abort.abort()
  await assert.rejects(canceled, { name: 'AbortError' }); assert.equal(cancelClock.tasks.size, 0)
  await assert.rejects(cancellable.complete({ messages, signal: abort.signal }), { name: 'AbortError' })
  setAuthenticatedUser('summary-user-a'); let publish = 0
  const stale = createWebSummaryPort(profile, { clock: clock(), fetch: async () => new Response('', { headers: { 'content-type': 'application/x-ndjson' } }), readStream: async (_response, onText) => { setAuthenticatedUser('summary-user-b'); onText('old account'); return { text: 'old account' } } })
  await assert.rejects(stale.complete({ messages, onText: () => publish++ }), { name: 'AbortError' }); assert.equal(publish, 0)
  const desktopClock = clock(); let input, canceledId
  const desktop = createDesktopSummaryPort(profile, { completeText: async request => { input = request; return { text: 'desktop' } }, cancelCompleteText: async id => { canceledId = id } }, desktopClock)
  assert.equal((await desktop.complete({ messages })).text, 'desktop'); assert.equal(input.requiresApiKey, false); assert.equal(input.profileId, 'summary'); assert.equal(desktopClock.tasks.size, 0)
  const pendingDesktop = createDesktopSummaryPort(profile, { completeText: request => { input = request; return new Promise(() => {}) }, cancelCompleteText: async id => { canceledId = id } }, desktopClock)
  const timed = pendingDesktop.complete({ messages }); desktopClock.fire()
  await assert.rejects(timed, /(?:timeout|timed out|逾時|超時)/i); assert.equal(canceledId, input.requestId); assert.equal(desktopClock.tasks.size, 0)
  const seen = []; let finalUpdates = 0
  const summary = await summarizeTranscript('A'.repeat(24000) + '\n' + 'B'.repeat(24000), { summaryInstruction: () => 'FINAL TEMPLATE', compressionFailure: () => Error('compression exhausted'), completeSummary: async (entries, _single, onText) => { seen.push(entries); onText?.('final stream'); return { text: entries[0].content === 'FINAL TEMPLATE' ? 'final result' : entries[1].content.includes('B') ? 'PART-B' : 'PART-A' } } }, () => finalUpdates++)
  assert.equal(summary, 'final result'); assert.equal(finalUpdates, 1); assert.ok(seen.some(entries => entries[1].content.includes('PART-A') && entries[1].content.includes('PART-B')), 'all chunks reach the merge')
  await assert.rejects(summarizeTranscript('A'.repeat(50000), { summaryInstruction: () => 'FINAL', compressionFailure: () => Error('compression exhausted'), completeSummary: async () => ({ text: 'X'.repeat(26000) }) }), /compression exhausted/)
  console.log('PASS direct summary ports: JSON/NDJSON, deadline through stream, cancellation, account-fenced partials, desktop cancel ID, hierarchical merge and bounded compression')
})().catch(error => { console.error(error); process.exitCode = 1 })
