const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

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
console.log('Diarization smoke test passed.')
