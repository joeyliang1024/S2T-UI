const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/app/services/translation-policy.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('translation-policy-smoke-module')
loaded.filename = 'translation-policy-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { canMergeHttpCaption, shouldAutoTranslate, maximumSentenceWaitMs } = loaded.exports

const caption = (update = {}) => ({ id: 'http-one', revision: 0, status: 'final', startMs: 0, endMs: 600, sourceText: 'hello', ...update })
assert.equal(canMergeHttpCaption(caption(), caption({ id: 'http-two', startMs: 650, endMs: 1200 }), -1), true)
assert.equal(canMergeHttpCaption(caption({ isSentenceBoundary: true }), caption({ id: 'http-two', startMs: 650, endMs: 1200 }), -1), false)
assert.equal(canMergeHttpCaption(caption(), caption({ id: 'http-two', startMs: 1500, endMs: 2000 }), -1), false)
assert.equal(shouldAutoTranslate(caption(), 'realtime', 700), true)
assert.equal(shouldAutoTranslate(caption(), 'sentence', 700), false)
assert.equal(shouldAutoTranslate(caption({ sourceText: 'hello.' }), 'sentence', 700), true)
assert.equal(shouldAutoTranslate(caption(), 'sentence', 600 + maximumSentenceWaitMs), true)
assert.equal(shouldAutoTranslate(caption({ translationStatus: 'failed' }), 'realtime', 700), false)
console.log('Translation policy smoke test passed.')
