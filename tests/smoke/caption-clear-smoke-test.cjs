const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const transpile = require('../helpers/transpile-typescript.cjs')
const hook = readFileSync('src/renderer/src/features/app/hooks/useAppController.ts', 'utf8')
const source = hook.slice(hook.indexOf('const clearCaptions ='), hook.indexOf('const saveLiveCaptionsBeforeSwitch ='))
const code = transpile(source).code
async function check(captureState) {
  const calls = []
  const ref = current => ({ current })
  const context = { captureState, stopCapture: async () => { calls.push('stopped') },
    translationQueueRef: ref({ reset: () => calls.push('reset'), paused: true }),
    unsubscribeModelRef: ref(() => calls.push('unsubscribed')), unsubscribeModelErrorRef: ref(() => {}),
    liveSessionIdRef: ref('old'), continuationTargetRef: ref({}), continuationEventIdsRef: ref(new Set(['old'])),
    savedLiveSnapshotRef: ref([{}]), transcriptsRef: ref([{}]), sampleOffsetRef: ref(16000), clearBoundaryRef: ref(1000),
    playbackUrlRef: ref(null), activeTranslate: key => key }
  for (const key of ['setTranscripts', 'setClearedThroughMs', 'setElapsedMs', 'setCaptionTimerOffsetMs', 'setSummaryText', 'setSummaryStatus', 'setEditingTranscriptId', 'setTranscriptSearch', 'setFollowingCaptions', 'setView', 'setCaptureState', 'setStatus', 'setViewingSessionId', 'setPlaybackUrl', 'setPlayingSessionId', 'setImportError', 'setImportProgress']) context[key] = value => calls.push([key, value])
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
  // The workspace itself returns to a fresh idle page, not just an empty list.
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setCaptureState' && item[1] === 'idle'), 'capture state returns to idle')
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setViewingSessionId' && item[1] === null), 'open session modal closes')
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setPlayingSessionId' && item[1] === null), 'playback stops')
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setStatus'), 'stale status message clears')
}
async function checkFailedStop() {
  const calls = []
  const ref = current => ({ current })
  const context = { captureState: 'recording', stopCapture: async () => { throw new Error('stop failed') },
    translationQueueRef: ref({ reset: () => calls.push('reset'), paused: true }),
    unsubscribeModelRef: ref(() => {}), unsubscribeModelErrorRef: ref(() => {}),
    liveSessionIdRef: ref('old'), continuationTargetRef: ref({}), continuationEventIdsRef: ref(new Set(['old'])),
    savedLiveSnapshotRef: ref(null), transcriptsRef: ref([{}]), sampleOffsetRef: ref(1), clearBoundaryRef: ref(1),
    playbackUrlRef: ref(null), activeTranslate: key => key }
  for (const key of ['setTranscripts', 'setClearedThroughMs', 'setElapsedMs', 'setCaptionTimerOffsetMs', 'setSummaryText', 'setSummaryStatus', 'setEditingTranscriptId', 'setTranscriptSearch', 'setFollowingCaptions', 'setView', 'setCaptureState', 'setStatus', 'setViewingSessionId', 'setPlaybackUrl', 'setPlayingSessionId', 'setImportError', 'setImportProgress']) context[key] = value => calls.push([key, value])
  const clear = new Function(...Object.keys(context), code + '; return clearCaptions')(...Object.values(context))
  await clear()
  assert.equal(context.liveSessionIdRef.current, null, 'a failed stop must still release the session identity')
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setCaptureState' && item[1] === 'idle'))
  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'setStatus' && item[1] === 'stop failed'), 'the stop failure is surfaced instead of rejecting the caller')
}
(async () => {
  for (const state of ['idle', 'recording', 'paused', 'starting', 'saving']) await check(state)
  await checkFailedStop()
  console.log('Caption clear smoke passed: stop before reset, fresh session, empty transcript, zero timer, busy guards, failed-stop reset.')
})().catch(error => { console.error(error); process.exitCode = 1 })
