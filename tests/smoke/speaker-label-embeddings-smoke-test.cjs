const assert = require('node:assert/strict')
const { extractSpeakerLabelEmbeddings } = require('../../server/sherpa-diarization.cjs')
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
console.log('Speaker label embedding model test passed.')
