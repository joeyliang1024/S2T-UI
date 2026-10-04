const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { assessVoiceprintSample, extractSpeakerLabelEmbeddings } = require('../../server/sherpa-diarization.cjs')

const wav = (seconds, amplitude) => {
  const rate = 16_000; const samples = Math.round(seconds * rate); const output = Buffer.alloc(44 + samples * 2)
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8); output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22); output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36); output.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index += 1) output.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(index / 9)), 44 + index * 2)
  return output
}

const result = buildSync({ entryPoints: ['src/renderer/src/features/speakers/diarization.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('diarization-smoke-module')
loaded.filename = 'diarization-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { assignSpeakersByOverlap, stabilizeSpeakerTurns } = loaded.exports

const previous = [{ startMs: 0, endMs: 20_000, speaker: 'SPEAKER_04' }]
const next = stabilizeSpeakerTurns(previous, [
  { startMs: 15_000, endMs: 22_000, speaker: 'SPEAKER_00' },
  { startMs: 22_000, endMs: 25_000, speaker: 'SPEAKER_01' },
  { startMs: 25_000, endMs: 28_000, speaker: 'NT-1234' }
])
assert.equal(next[0].speaker, 'SPEAKER_04', 'overlapping anonymous speaker must retain its prior label')
assert.equal(next[1].speaker, 'SPEAKER_05', 'new anonymous speaker receives the next stable label')
assert.equal(next[2].speaker, 'NT-1234', 'recognized NT must never be rewritten')
assert.equal(stabilizeSpeakerTurns([{ startMs: 0, endMs: 10_000, speaker: 'NT-1234' }], [{ startMs: 5_000, endMs: 12_000, speaker: 'SPEAKER_00' }])[0].speaker, 'SPEAKER_00', 'an old identity match must not relabel a new anonymous window')
const twoNew = stabilizeSpeakerTurns([{ startMs: 0, endMs: 10_000, speaker: 'SPEAKER_01' }], [{ startMs: 5_000, endMs: 12_000, speaker: 'SPEAKER_00' }, { startMs: 5_000, endMs: 12_000, speaker: 'SPEAKER_02' }])
assert.notEqual(twoNew[0].speaker, twoNew[1].speaker, 'two incoming anonymous labels must not claim one prior identity')

const captions = [
  { id: 'one', revision: 0, status: 'final', startMs: 15_500, endMs: 18_000, sourceText: 'one' },
  { id: 'manual', revision: 0, status: 'final', startMs: 22_000, endMs: 24_000, sourceText: 'two', speaker: 'manual', speakerManuallyEdited: true }
]
const assigned = assignSpeakersByOverlap(captions, next)
assert.equal(assigned[0].speaker, 'SPEAKER_04')
assert.equal(assigned[1].speaker, 'manual', 'manual labels are authoritative')
assert.equal(assignSpeakersByOverlap([{ id: 'edge', revision: 0, status: 'final', startMs: 18_000, endMs: 28_000, sourceText: 'edge' }], [{ startMs: 18_000, endMs: 19_000, speaker: 'SPEAKER_04' }])[0].speaker, undefined, 'a tiny boundary overlap must not mislabel a caption')
assert.deepEqual(assessVoiceprintSample(wav(3.2, 0.2)).durationMs, 3200)
assert.throws(() => assessVoiceprintSample(wav(2.9, 0.2)), /至少需要 3 秒/)
assert.throws(() => assessVoiceprintSample(wav(3.2, 0.001)), /音量過低/)
assert.throws(() => assessVoiceprintSample(wav(3.2, 1)), /削波過多/)

// --------------------------------------------------- per-label voiceprints
// The sliding-window stabilizer receives one vector per diarization label from
// the preview response (VOICEPRINT_ACCURACY §12.8). It must group audio by
// label, drop anything too short or outside the file, and never throw — a
// window that cannot be embedded still has captions and overlap to fall back on.
{
  const frames = Math.round(6 * 16_000)
  const audio = Buffer.alloc(44 + frames * 2)
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8); audio.write('fmt ', 12)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16_000, 24)
  audio.writeUInt32LE(32_000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36)
  audio.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index += 1) audio.writeInt16LE(Math.round(0.2 * 32767 * Math.sin(index / 9)), 44 + index * 2)

  const labels = extractSpeakerLabelEmbeddings(audio, [
    { start: 0, end: 3, speaker: 'SPEAKER_00' },
    { start: 3, end: 6, speaker: 'SPEAKER_01' },
    { start: 0, end: 0.5, speaker: 'SPEAKER_02' },
    { start: 7, end: 9, speaker: 'SPEAKER_03' },
    { start: 1, end: NaN, speaker: 'SPEAKER_04' }
  ])
  assert.deepEqual(Object.keys(labels).sort(), ['SPEAKER_00', 'SPEAKER_01'], 'only labels with at least a second of in-range audio are embedded')
  assert.equal(new Set(Object.values(labels).map((vector) => vector.length)).size, 1, 'every label yields the same embedding dimension')
  assert.ok(Object.values(labels).every((vector) => vector.length >= 16 && vector.every(Number.isFinite)), 'embeddings are finite and usable')
  assert.deepEqual(extractSpeakerLabelEmbeddings(audio, []), {}, 'no segments means no vectors, not an error')
  assert.deepEqual(extractSpeakerLabelEmbeddings(audio, [{ start: 0, end: 3 }]), {}, 'a segment without a label is ignored')
}
console.log('Diarization smoke test passed.')
