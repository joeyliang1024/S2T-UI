const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/shared/services/transcript.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('transcript-export-smoke-module')
loaded.filename = 'transcript-export-smoke-module.cjs'; loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { makeTranscriptCsv, makeVtt } = loaded.exports

const entries = [
  { id: 'a', revision: 1, status: 'final', startMs: 1_250, endMs: 3_500, speaker: 'NT-001', sourceText: 'A < B & C', translatedText: 'Translated' },
  { id: 'gap', revision: 1, status: 'gap', startMs: 4_000, endMs: 5_000, sourceText: '', gapReason: 'request-failed' }
]
const vtt = makeVtt(entries)
assert.match(vtt, /^WEBVTT\n\n/)
assert.match(vtt, /00:00:01\.250 --> 00:00:03\.500/)
assert.match(vtt, /<v NT-001>A &lt; B &amp; C/)
assert.match(vtt, /<v NT-001>Translated/)
assert.doesNotMatch(vtt, /request-failed/)
const csv = makeTranscriptCsv(entries)
assert.ok(csv.startsWith('\uFEFFstart_ms,end_ms'))
assert.match(csv, /"NT-001"/)
assert.match(csv, /"request-failed"/)
console.log('Transcript export smoke test passed.')
