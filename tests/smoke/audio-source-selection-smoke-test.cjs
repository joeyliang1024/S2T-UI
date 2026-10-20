const assert = require('node:assert/strict')
const fs = require('node:fs')
const { buildSync } = require('esbuild')
const source = fs.readFileSync('src/renderer/src/features/app/hooks/useAppController.ts', 'utf8')
const handler = source.slice(source.indexOf('const applyAudioSources ='), source.indexOf('const startCapture ='))
const code = buildSync({ stdin: { contents: handler + '\nreturn applyAudioSources;', loader: 'ts' }, format: 'cjs', write: false }).outputFiles[0].text
const stream = () => { const audio = { readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended' } }; const video = { stopped: false, stop() { this.stopped = true } }; return { audio, video, getAudioTracks: () => [audio], getTracks: () => [audio, video] } }
const fixture = (captureState = 'recording') => {
  const old = stream(), calls = [], source = { disconnected: false, disconnect() { this.disconnected = true } }
  const state = { captureState, systemStreamRef: { current: old }, systemSourceRef: { current: source }, contextRef: { current: {} }, activeDevice: 'default', enabled: true, level: -12, failMic: false }
  const selectDevice = async id => { if (state.failMic) throw new Error('mic failed'); calls.push(['mic', id]); state.activeDevice = id }
  const attachSystemAudio = next => { calls.push(['attach', next]); state.systemStreamRef.current = next; state.systemSourceRef.current = { disconnect() {} } }
  const apply = new Function('captureState', 'systemStreamRef', 'systemSourceRef', 'contextRef', 'activeTranslate', 'selectDevice', 'attachSystemAudio', 'setIncludeSystemAudio', 'setSystemLevel', code)(captureState, state.systemStreamRef, state.systemSourceRef, state.contextRef, key => key, selectDevice, attachSystemAudio, value => state.enabled = value, value => state.level = value)
  return { state, old, source, calls, apply }
}
;(async () => {
  let f = fixture(), next = stream()
  await f.apply('none', true, next)
  assert.equal(f.calls[0][0], 'attach', 'attach computer audio before turning off the microphone')
  assert.deepEqual(f.calls[1], ['mic', 'none'])
  assert.ok(f.old.audio.stopped && f.old.video.stopped && f.source.disconnected)
  assert.equal(f.state.systemStreamRef.current, next); assert.equal(next.audio.stopped, false)
  f = fixture(); await f.apply('usb', false)
  assert.equal(f.state.activeDevice, 'usb'); assert.equal(f.state.enabled, false)
  assert.equal(f.state.systemStreamRef.current, null); assert.ok(f.old.audio.stopped)
  f = fixture(); await f.apply('usb', true)
  assert.equal(f.state.systemStreamRef.current, f.old); assert.equal(f.old.audio.stopped, false)
  f = fixture(); next = stream(); f.state.failMic = true
  await assert.rejects(f.apply('usb', true, next), /mic failed/)
  assert.equal(f.state.systemStreamRef.current, f.old); assert.equal(f.old.audio.stopped, false)
  f = fixture(); await assert.rejects(f.apply('none', false), /stAtLeastOneSourceRequired/)
  next = stream(); next.audio.readyState = 'ended'
  await assert.rejects(f.apply('usb', true, next), /stShareSourceNoAudio/)
  assert.deepEqual(f.calls, [], 'invalid choices leave the active sources untouched')
  f = fixture('idle'); next = stream(); await f.apply('none', true, next)
  assert.equal(f.state.systemStreamRef.current, next); assert.equal(next.audio.stopped, false)
  assert.equal(f.calls.some(call => call[0] === 'attach'), false, 'idle selection retains the prepared source without starting capture')
  const dispatchSource = source.slice(source.indexOf('const startOrContinueRecording ='), source.indexOf('const selectAudioVersion ='))
  const dispatchCode = buildSync({ stdin: { contents: dispatchSource + '\nreturn startOrContinueRecording;', loader: 'ts' }, format: 'cjs', write: false }).outputFiles[0].text
  const starts = [], continues = [], entry = { id: 'existing' }, liveSessionIdRef = { current: null }
  const dispatch = new Function('sessions', 'liveSessionIdRef', 'startCapture', 'continueSession', dispatchCode)([entry], liveSessionIdRef, async choice => starts.push(choice), async (record, choice) => continues.push({ record, choice }))
  const confirmedChoice = { deviceId: 'usb', systemEnabled: true }
  assert.equal(starts.length, 0)
  await dispatch(confirmedChoice)
  assert.deepEqual(starts, [confirmedChoice], 'start uses the explicit confirmed source choice')
  liveSessionIdRef.current = 'existing'
  await dispatch(confirmedChoice)
  assert.deepEqual(continues, [{ record: entry, choice: confirmedChoice }], 'continuation receives the same confirmed source choice')
  console.log('PASS extra audio-source selection: system-only/mic-only, prepared-stream adoption, existing-source retention, replacement cleanup and failure guards')
})().catch(error => { console.error(error); process.exitCode = 1 })
