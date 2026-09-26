const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/app/services/glossary-json.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('glossary-json-smoke-module')
loaded.filename = 'glossary-json-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { parseGlossaryJson } = loaded.exports

const objectResult = parseGlossaryJson(JSON.stringify({ Breeze: '微風', OpenAI: 'OpenAI' }))
assert.deepEqual(objectResult.entries, ['Breeze => 微風', 'OpenAI => OpenAI'])
const arrayResult = parseGlossaryJson(JSON.stringify([{ term: 'Breeze', translation: '微風' }, 'Breeze => 微風', { term: 'bad' }, null]))
assert.deepEqual(arrayResult.entries, ['Breeze => 微風'])
assert.equal(arrayResult.invalidEntries, 2)
assert.equal(arrayResult.ignoredDuplicates, 1)
assert.throws(() => parseGlossaryJson('[]'), /empty-glossary/)
assert.throws(() => parseGlossaryJson('"text"'), /invalid-root/)
assert.throws(() => parseGlossaryJson('{'), /invalid-json/)
console.log('Glossary JSON smoke test passed.')
