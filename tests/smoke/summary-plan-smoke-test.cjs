const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/app/services/summary-plan.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('summary-plan-smoke-module')
loaded.filename = 'summary-plan-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { summaryChunks, summaryBatches, transcriptSignature } = loaded.exports

const transcript = '第一段內容。\n第二段內容。\n第三段內容。'
const chunks = summaryChunks(transcript, 9)
assert.equal(chunks.join(''), transcript)
assert.ok(chunks.length > 1)
assert.deepEqual(summaryBatches(['aaaa', 'bbbb', 'cccc'], 12), [['aaaa'], ['bbbb'], ['cccc']])
assert.deepEqual(summaryBatches(['aaaa', 'bbbb', 'cccc'], 20), [['aaaa', 'bbbb'], ['cccc']])
assert.equal(transcriptSignature(transcript), transcriptSignature(transcript))
assert.notEqual(transcriptSignature(transcript), transcriptSignature(`${transcript}!`))
console.log('Summary plan smoke test passed.')
