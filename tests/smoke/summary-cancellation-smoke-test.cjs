const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const code = buildSync({
  entryPoints: ['frontend/src/features/summary/services/summarize-transcript.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text
const moduleValue = { exports: {} }
new Function('module', 'exports', 'require', code)(moduleValue, moduleValue.exports, require)
const { summarizeTranscript } = moduleValue.exports
const dependencies = (completeSummary) => ({ completeSummary, summaryInstruction: () => 'template', compressionFailure: () => Error('compression failed') })

;(async () => {
  const chunkAbort = new AbortController()
  let chunkCalls = 0
  await assert.rejects(
    summarizeTranscript('A'.repeat(70_000), dependencies(async () => {
      chunkCalls += 1
      chunkAbort.abort()
      return { text: 'partial' }
    }), undefined, chunkAbort.signal),
    error => error?.name === 'AbortError'
  )
  assert.equal(chunkCalls, 1, 'an abort between chunks must not start the next provider call')

  const lateAbort = new AbortController()
  let resolveLate
  let stream
  const published = []
  const pending = summarizeTranscript('short transcript', dependencies((_messages, _singleAttempt, onText, signal) => new Promise(resolve => {
    stream = onText
    resolveLate = () => resolve({ text: 'late final' })
    assert.equal(signal, lateAbort.signal, 'the request signal reaches the provider')
  })), text => published.push(text), lateAbort.signal)
  lateAbort.abort()
  assert.throws(() => stream('late partial'), error => error?.name === 'AbortError', 'a late stream callback is fenced')
  resolveLate()
  await assert.rejects(pending, error => error?.name === 'AbortError')
  assert.deepEqual(published, [], 'late partials and results cannot publish after cancellation')

  let active=0,peak=0,calls=0
  await summarizeTranscript('A'.repeat(140000),dependencies(async()=>{
    calls++;active++;peak=Math.max(peak,active)
    await new Promise(resolve=>setTimeout(resolve,5));active--;return {text:'partial'}
  }))
  assert.equal(peak,2,'long summaries bound parallel chunk/merge requests to two')
  assert.ok(calls>6,'all chunks and subsequent merge stages still finish')
  console.log('PASS summary cancellation stops subsequent chunks and fences late stream/final results')
})().catch(error => { console.error(error); process.exitCode = 1 })
