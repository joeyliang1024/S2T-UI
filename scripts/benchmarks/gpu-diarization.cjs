// Run explicitly on a CUDA host, with a user-selected local PCM WAV fixture.
const { readFileSync } = require('node:fs')
const { performance } = require('node:perf_hooks')
const { inferenceConfig } = require('../../server/inference-config.cjs')
const { verifyRuntime, diarizeWav } = require('../../server/nemotron-diarization.cjs')
const { readWavSamples } = require('../../server/audio/wav.cjs')
try {
  const audioIndex = process.argv.indexOf('--audio')
  if (audioIndex < 0 || !process.argv[audioIndex + 1]) throw new Error('Usage: node scripts/benchmarks/gpu-diarization.cjs --audio /path/to/fixture.wav')
  const config = inferenceConfig()
  if (config.backend !== 'cuda') throw new Error('GPU acceptance requires S2T_INFERENCE_BACKEND=cuda')
  const runtime = verifyRuntime()
  const audio = readFileSync(process.argv[audioIndex + 1])
  const wav = readWavSamples(audio)
  const durationSeconds = wav.samples.length / wav.sampleRate
  if (!(durationSeconds > 0)) throw new Error('Audio fixture is empty')
  const start = performance.now()
  const turns = diarizeWav(audio)
  const elapsedMs = performance.now() - start
  console.log(JSON.stringify({ passed: true, inference: runtime.inference, durationSeconds, elapsedMs, realTimeFactor: elapsedMs / (durationSeconds * 1000), turns: turns.length, scope: 'native CLI invocation including model load; not a warmed inference-only benchmark' }))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
