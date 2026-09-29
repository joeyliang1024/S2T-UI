const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { assessVoiceprintSample } = require('../server/sherpa-diarization.cjs')

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
console.log('Diarization smoke test passed.')
