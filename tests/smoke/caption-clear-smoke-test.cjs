const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const ts = require('typescript')
const hook = readFileSync('src/renderer/src/features/app/hooks/useAppController.ts', 'utf8')
const source = hook.slice(hook.indexOf('const clearCaptions ='), hook.indexOf('const saveLiveCaptionsBeforeSwitch ='))
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
async function check(captureState) {
  const calls = []
  const ref = current => ({ current })
  const context = { captureState, stopCapture: async () => { calls.push('stopped') },
    translationQueueRef: ref({ reset: () => calls.push('reset'), paused: true }),
    unsubscribeModelRef: ref(() => calls.push('unsubscribed')), unsubscribeModelErrorRef: ref(() => {}),
    liveSessionIdRef: ref('old'), continuationTargetRef: ref({}), continuationEventIdsRef: ref(new Set(['old'])),
    savedLiveSnapshotRef: ref([{}]), transcriptsRef: ref([{}]), sampleOffsetRef: ref(16000), clearBoundaryRef: ref(1000) }
  for (const key of ['setTranscripts', 'setClearedThroughMs', 'setElapsedMs', 'setCaptionTimerOffsetMs', 'setSummaryText', 'setSummaryStatus', 'setEditingTranscriptId', 'setTranscriptSearch', 'setFollowingCaptions', 'setView']) context[key] = value => calls.push([key, value])
  const clear = new Function(...Object.keys(context), code + '; return clearCaptions')(...Object.values(context))
  await clear()
  if (captureState === 'starting' || captureState === 'saving') { assert.deepEqual(calls, []); return }
  if (captureState !== 'idle') assert.equal(calls[0], 'stopped', 'finish the recording before resetting session state')
  assert.equal(context.liveSessionIdRef.current, null, 'next start cannot continue the previous session')
  assert.equal(context.continuationTargetRef.current, null)
  assert.equal(context.continuationEventIdsRef.current.size, 0)
  assert.deepEqual(context.transcriptsRef.current, [])
  assert.equal(context.sampleOffsetRef.current, 0)
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setElapsedMs' && item[1] === 0))
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setView' && item[1] === 'live'))
}
(async () => {
  for (const state of ['idle', 'recording', 'paused', 'starting', 'saving']) await check(state)
  console.log('Caption clear smoke passed: stop before reset, fresh session, empty transcript, zero timer, busy guards.')
})().catch(error => { console.error(error); process.exitCode = 1 })
