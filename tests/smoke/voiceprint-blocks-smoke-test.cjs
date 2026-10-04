const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { extractDiarizedSpeakerBlocks, assessVoiceprintSample, shouldVetoRecording } = require('../../server/sherpa-diarization.cjs')
const { analyzeWav } = require('../../server/silero-vad.cjs')

// The fixtures below are synthetic formant tones, not speech. The
// recording-level VAD veto would (correctly) reject them, which would hide the
// block-building assertions, so the veto is switched off here and switched
// back on for its own section at the end.
process.env.S2T_VOICEPRINT_AUDIO_VAD = '0'

// Synthetic 16 kHz speech-shaped tone: enough energy for the RMS gate while
// staying deterministic and model-independent. Amplitude is per-time-unit so
// a quiet region can be placed inside the single data chunk.
const makeWav = ({ seconds, amplitude = .2, amplitudeOf }) => {
  const sampleRate = 16_000
  const frames = Math.round(seconds * sampleRate)
  const output = Buffer.alloc(44 + frames * 2)
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22)
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34)
  output.write('data', 36); output.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index += 1) {
    const time = index / sampleRate
    const gain = amplitudeOf ? amplitudeOf(time) : amplitude
    // Two formant-like partials so the embedding model sees speech-shaped
    // energy instead of a pure (possibly filtered-out) sine.
    const value = gain * (Math.sin(time * Math.PI * 2 * 180) + .4 * Math.sin(time * Math.PI * 2 * 720))
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(value * 32_767))), 44 + index * 2)
  }
  return output
}

const silenceWav = (seconds) => makeWav({ seconds, amplitude: 0 })

;(async () => {
  // --- block construction -------------------------------------------------
  // One data chunk: the WAV reader stops at the first one, so regions are
  // encoded by amplitude instead of by concatenating files.
  const audio = makeWav({ seconds: 75, amplitudeOf: (time) => (time >= 60 && time < 70 ? .0001 : .2) })
  // Speaker with plenty of speech: one block fills to the 15 s cap, the rest
  // becomes a second block; a 0.8 s turn is dropped before embedding.
  const rich = [
    { start: 2, end: 9, speaker: 'SPEAKER_00' },
    { start: 12, end: 20, speaker: 'SPEAKER_00' },
    { start: 25, end: 31, speaker: 'SPEAKER_00' },
    { start: 40, end: 43, speaker: 'SPEAKER_00' },
    { start: 50, end: 50.8, speaker: 'SPEAKER_00' }
  ]
  const short = [{ start: 1, end: 4, speaker: 'SPEAKER_02' }]
  const quiet = [{ start: 61, end: 69, speaker: 'SPEAKER_01' }]
  // One continuous 40 s turn: must be sliced, never embedded as a whole.
  const monologue = [{ start: 0, end: 40, speaker: 'SPEAKER_03' }]

  const result = await extractDiarizedSpeakerBlocks(audio, [...rich, ...short, ...quiet, ...monologue])
  const bySpeaker = new Map(result.map((item) => [item.speaker, item]))
  assert.equal(result.length, 4, 'every diarized speaker stays in the report')

  const loud = bySpeaker.get('SPEAKER_00')
  assert.ok(loud.speechMs >= 24_000, `usable speech is measured without the dropped turn, got ${loud.speechMs}`)
  assert.ok(loud.blocks.length >= 2 && loud.blocks.length <= 3, `expected bounded blocks, got ${loud.blocks.length}`)
  assert.ok(loud.blocks[0].durationMs <= 15_000, `a block must never exceed the cap, got ${loud.blocks[0].durationMs}`)
  assert.ok(loud.blocks[0].durationMs >= 5_000, 'blocks below the minimum length are discarded')
  assert.ok(Array.isArray(loud.blocks[0].embedding) && loud.blocks[0].embedding.length > 0, 'each block carries its own embedding')
  assert.ok(loud.blocks.every((block) => block.embedding.length === loud.blocks[0].embedding.length))
  assert.notEqual(loud.blocks[0].endSec, loud.blocks[1].endSec, 'blocks cover different time ranges')

  assert.deepEqual(bySpeaker.get('SPEAKER_02').blocks, [], 'a speaker with 3 s of speech is never embedded')
  assert.deepEqual(bySpeaker.get('SPEAKER_01').blocks, [], 'a speaker below the energy gate is never embedded')

  const solo = bySpeaker.get('SPEAKER_03')
  assert.equal(solo.blocks.length, 3, 'a single continuous turn is sliced into several blocks')
  assert.ok(solo.blocks.every((block) => block.durationMs <= 15_000), 'no slice may exceed the block cap')
  assert.equal(solo.blocks.reduce((sum, block) => sum + block.durationMs, 0), 40_000, 'slices cover the whole turn')
  assert.ok(solo.blocks.every((block) => block.embedding.length > 0))

  assert.throws(() => assessVoiceprintSample(silenceWav(1)), /至少需要 3 秒/)

  // --- silero: bounded responses ----------------------------------------
  const silent = await analyzeWav(silenceWav(1))
  assert.equal(silent.durationMs, 1_000)
  assert.deepEqual(silent.speech, [])
  assert.equal('probabilities' in silent, false, 'frame probabilities are opt-in')
  const withFrames = await analyzeWav(silenceWav(1), { includeProbabilities: true })
  assert.ok(Array.isArray(withFrames.probabilities) && withFrames.probabilities.length > 0)
  assert.equal(typeof withFrames.probabilities[0].probability, 'number')

  // --- recording-level veto -----------------------------------------------
  const vetoOptions = { enabled: true, minVoicedSec: 10, minVoicedRatio: 0.05 }
  assert.equal(shouldVetoRecording(5.8, 238.4, vetoOptions), true, 'a music-only recording is vetoed')
  assert.equal(shouldVetoRecording(0, 30, vetoOptions), true, 'a recording without any speech is vetoed')
  assert.equal(shouldVetoRecording(600, 1_800, vetoOptions), false, 'a conversation is voiced tens of percent of the time')
  assert.equal(shouldVetoRecording(2.5, 3, vetoOptions), false, 'a short but fully spoken clip must not be vetoed')
  assert.equal(shouldVetoRecording(5.8, 238.4, { ...vetoOptions, enabled: false }), false, 'S2T_VOICEPRINT_AUDIO_VAD=0 turns the veto off')
  assert.equal(shouldVetoRecording(1, 0, vetoOptions), false, 'an unknown duration never vetoes')

  // Same loud synthetic audio as above, veto enabled: it clears the energy
  // gate but contains no speech, so nothing may reach the embedding model.
  process.env.S2T_VOICEPRINT_AUDIO_VAD = '1'
  const vetoed = await extractDiarizedSpeakerBlocks(makeWav({ seconds: 75, amplitudeOf: (time) => (time >= 60 && time < 70 ? .0001 : .2) }), [{ start: 2, end: 40, speaker: 'SPEAKER_00' }])
  assert.equal(vetoed.length, 1)
  assert.equal(vetoed[0].vetoed, true, 'a recording without speech is vetoed before any embedding runs')
  assert.deepEqual(vetoed[0].blocks, [], 'a vetoed recording contributes no embeddings')
  assert.ok(vetoed[0].speechMs > 0, 'the report still states how much diarized speech there was')

  // Real speech must survive the veto: 9.9 s of synthesized voice, above both
  // the voiced-seconds and the voiced-ratio limits.
  const speech = await extractDiarizedSpeakerBlocks(readFileSync(resolve(__dirname, '../fixtures', 'speech-sample.wav')), [{ start: 0, end: 9.9, speaker: 'SPEAKER_00' }])
  assert.notEqual(speech[0].vetoed, true, 'speech is never vetoed')
  assert.ok(speech[0].blocks.length >= 1, 'speech still produces blocks once the veto has passed')
  process.env.S2T_VOICEPRINT_AUDIO_VAD = '0'

  console.log('voiceprint blocks smoke test passed.')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
