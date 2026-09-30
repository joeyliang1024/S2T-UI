// Regression test for the Silero VAD feeding bug.
//
// The ONNX wrapper expects the 64-sample context tail in front of every
// 512-sample window. Feeding bare 512 samples runs without error but returns
// ~0.003 for *every* frame, so the API reported no speech for anything — which
// drops every caption chunk when the UI's "使用 Silero VAD" option is on, and
// would veto every voiceprint block when `S2T_VOICEPRINT_VAD=1`. This test
// asserts that real speech is detected and that the peak probability is in the
// range a working VAD produces.
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { analyzeWav } = require('../server/silero-vad.cjs')

const silenceWav = (seconds) => {
  const frames = Math.round(16_000 * seconds)
  const payload = Buffer.alloc(frames * 2)
  const output = Buffer.alloc(44 + payload.length)
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22)
  output.writeUInt32LE(16_000, 24); output.writeUInt32LE(32_000, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34)
  output.write('data', 36); output.writeUInt32LE(payload.length, 40)
  return output
}

const ratioOf = (result) => {
  const voiced = result.speech.reduce((sum, interval) => sum + Math.max(0, interval.endMs - interval.startMs), 0)
  return result.durationMs ? voiced / result.durationMs : 0
}

const main = async () => {
  const speech = await analyzeWav(readFileSync(resolve(__dirname, 'fixtures', 'speech-sample.wav')), { includeProbabilities: true })
  const ratio = ratioOf(speech)
  const peak = Math.max(0, ...(speech.probabilities || []).map((frame) => frame.probability))
  if (!speech.speech.length) throw new Error('silence detected in a speech fixture — the VAD feeding is broken again')
  if (ratio < 0.5) throw new Error(`expected most of the speech fixture to be voiced, got ratio ${ratio.toFixed(3)}`)
  if (peak < 0.9) throw new Error(`peak probability ${peak.toFixed(3)} is in the collapsed range (~0.003) seen with the missing context tail`)

  const quiet = await analyzeWav(silenceWav(1), { includeProbabilities: true })
  const quietPeak = Math.max(0, ...(quiet.probabilities || []).map((frame) => frame.probability))
  if (quiet.speech.length) throw new Error('silence must not be reported as speech')
  if (quietPeak > 0.4) throw new Error(`silence peak ${quietPeak.toFixed(3)} is implausibly high`)

  console.log(`Silero VAD smoke test passed (speech ratio ${ratio.toFixed(3)}, peak ${peak.toFixed(3)}, silence peak ${quietPeak.toFixed(3)}).`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
