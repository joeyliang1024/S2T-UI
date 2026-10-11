const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/capture/vad.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const sileroResult = buildSync({ entryPoints: ['src/renderer/src/features/capture/silero-vad.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('vad-smoke-module')
loaded.filename = 'vad-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { EnergyVad } = loaded.exports
const sileroLoaded = new LoadedModule('vad-smoke-silero-module')
sileroLoaded.filename = 'vad-smoke-silero-module.cjs'
sileroLoaded.paths = module.paths
sileroLoaded._compile(sileroResult.outputFiles[0].text, sileroLoaded.filename)
const { SileroBoundaryVad } = sileroLoaded.exports

const frame = (amplitude, samples = 160) => new Float32Array(samples).fill(amplitude)
const vad = new EnergyVad(16_000, { minSpeechMs: 30, minSilenceMs: 50, preRollMs: 100, noiseFloorOffsetDb: 12, chunkMinMs: 500, chunkMaxMs: 2_000 })

assert.equal(vad.process(frame(.2)).speechStarted, false, 'speech waits for minimum onset')
assert.equal(vad.process(frame(.2)).speechStarted, false, '20 ms onset is still too short')
assert.equal(vad.process(frame(.2)).speechStarted, true, 'speech starts after the configured onset')
assert.equal(vad.process(frame(0)).speechEnded, false, 'a 10 ms pause must not split a sentence')
assert.equal(vad.process(frame(.2)).speaking, true, 'speech resumes after a short pause')
vad.process(frame(0)); vad.process(frame(0)); vad.process(frame(0)); vad.process(frame(0))
assert.equal(vad.process(frame(0)).speechEnded, true, 'a pause at the configured silence threshold ends the sentence')

for (const sampleRate of [16_000, 44_100, 48_000]) {
  const detector = new EnergyVad(sampleRate)
  let started = false
  for (let offset = 0; offset < sampleRate; offset += 128) {
    const audio = Float32Array.from({ length: 128 }, (_, index) => .02 * Math.sin(2 * Math.PI * 180 * (offset + index) / sampleRate))
    started ||= detector.process(audio).speechStarted
  }
  assert.ok(started, `normal speech in 128-sample frames must start at ${sampleRate} Hz`)
  const silent = new EnergyVad(sampleRate)
  for (let offset = 0; offset < sampleRate; offset += 128) {
    assert.equal(silent.process(new Float32Array(128)).speaking, false)
  }
}

// SileroBoundaryVad：機率由外部注入（產品碼由 Node/main 的 ONNX 產生），
// 這裡以合成機率驗證與 EnergyVad 相同的起音／停頓遲滯與 sample 換算。
{
  const config = { minSpeechMs: 64, minSilenceMs: 96, preRollMs: 100, noiseFloorOffsetDb: 12, chunkMinMs: 500, chunkMaxMs: 2_000 }
  const probabilities = Float32Array.from([0, 0, .9, .9, .9, 0, 0, 0, 0, .9, .9, 0, 0, 0, 0, 0])
  const vad = new SileroBoundaryVad(16_000, config, probabilities)
  const silence = new Float32Array(512)
  assert.equal(vad.process(silence).speechStarted, false, 'silero: silence before the first voiced window')
  vad.process(silence)
  assert.equal(vad.process(silence).speechStarted, false, 'silero: speech waits for the minimum voiced windows')
  const onset = vad.process(silence)
  assert.equal(onset.speechStarted, true, 'silero: speech starts after two 32 ms voiced windows')
  assert.equal(onset.onsetSamples, 1_024, 'silero: onset maps back to the first voiced window')
  vad.process(silence)
  vad.process(silence)
  vad.process(silence)
  assert.equal(vad.process(silence).speechEnded, true, 'silero: a pause at the configured silence threshold ends the sentence')
  vad.process(silence)
  vad.process(silence)
  assert.equal(vad.process(silence).speechStarted, true, 'silero: a second utterance starts after the pause')

  // 48 kHz 收音：機率時間軸固定在 16 kHz 每 512 樣本一窗，推入樣本須正確映射。
  const highRate = new SileroBoundaryVad(48_000, config, new Float32Array(64).fill(.9))
  let started = false
  for (let offset = 0; offset < 48_000; offset += 128) started ||= highRate.process(new Float32Array(128)).speechStarted
  assert.ok(started, 'silero: voiced windows must start speech at 48 kHz')
  const quiet = new SileroBoundaryVad(48_000, config, new Float32Array(64))
  for (let offset = 0; offset < 48_000; offset += 128) assert.equal(quiet.process(new Float32Array(128)).speaking, false)
}

console.log('VAD smoke test passed.')
