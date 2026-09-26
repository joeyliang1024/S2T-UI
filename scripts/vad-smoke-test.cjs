const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/capture/vad.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('vad-smoke-module')
loaded.filename = 'vad-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { EnergyVad } = loaded.exports

const frame = (amplitude, samples = 160) => new Float32Array(samples).fill(amplitude)
const vad = new EnergyVad(16_000, { minSpeechMs: 30, minSilenceMs: 50, preRollMs: 100, noiseFloorOffsetDb: 12, chunkMinMs: 500, chunkMaxMs: 2_000 })

assert.equal(vad.process(frame(.2)).speechStarted, false, 'speech waits for minimum onset')
assert.equal(vad.process(frame(.2)).speechStarted, false, '20 ms onset is still too short')
assert.equal(vad.process(frame(.2)).speechStarted, true, 'speech starts after the configured onset')
assert.equal(vad.process(frame(0)).speechEnded, false, 'a 10 ms pause must not split a sentence')
assert.equal(vad.process(frame(.2)).speaking, true, 'speech resumes after a short pause')
vad.process(frame(0)); vad.process(frame(0)); vad.process(frame(0)); vad.process(frame(0))
assert.equal(vad.process(frame(0)).speechEnded, true, 'a pause at the configured silence threshold ends the sentence')

console.log('VAD smoke test passed.')
