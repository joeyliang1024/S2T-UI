const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/transcript/import-checkpoint.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('import-checkpoint-smoke-module')
loaded.filename = 'import-checkpoint-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { importFileFingerprint, importModelSnapshot, matchesImportCheckpoint } = loaded.exports

const file = { name: 'meeting.wav', size: 12_000_000, lastModified: 1_700_000_000_000 }
const model = { id: 'asr-a', endpoint: 'https://asr.example/v1', model: 'speech-a', capabilities: { supportedSampleRates: [16_000] } }
const fingerprint = importFileFingerprint(file)
const modelSnapshot = importModelSnapshot(model)
const checkpoint = { fingerprint, modelId: model.id, modelSnapshot, sourceLanguage: 'zh-TW', prompt: 'term=A', totalChunks: 4, nextChunkIndex: 2, nextByteOffset: 9000, segments: [], mergedText: '已完成', updatedAt: new Date().toISOString() }
assert.equal(matchesImportCheckpoint(checkpoint, { fingerprint, modelId: model.id, modelSnapshot, sourceLanguage: 'zh-TW', prompt: 'term=A', totalChunks: 4 }), true)
assert.equal(matchesImportCheckpoint(checkpoint, { fingerprint, modelId: model.id, modelSnapshot, sourceLanguage: 'en-US', prompt: 'term=A', totalChunks: 4 }), false)
assert.equal(matchesImportCheckpoint(checkpoint, { fingerprint, modelId: model.id, modelSnapshot: importModelSnapshot({ ...model, model: 'speech-b' }), sourceLanguage: 'zh-TW', prompt: 'term=A', totalChunks: 4 }), false)
assert.equal(matchesImportCheckpoint(checkpoint, { fingerprint: importFileFingerprint({ ...file, size: file.size + 1 }), modelId: model.id, modelSnapshot, sourceLanguage: 'zh-TW', prompt: 'term=A', totalChunks: 4 }), false)
console.log('Import checkpoint smoke test passed.')
