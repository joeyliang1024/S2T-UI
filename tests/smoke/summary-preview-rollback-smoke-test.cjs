const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const code = buildSync({
  entryPoints: ['src/renderer/src/features/summary/domain/summary-preview.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text
const moduleValue = { exports: {} }
new Function('module', 'exports', 'require', code)(moduleValue, moduleValue.exports, require)
const { revertSummaryPreview } = moduleValue.exports

const previous = {
  summary: '# Previous summary', summaryState: undefined, summaryError: undefined,
  summarySourceSignature: 'signature', summarySourceVersionId: 'version-1',
  summaryTranslation: '# Previous translation', summaryTranslationTargetLanguage: 'ja'
}
const record = { id: 'a', title: 'A', createdAt: '2026-10-17', durationMs: 1, source: 'fixture', transcript: 'transcript', audioKey: 'a', segments: [] }
const preview = '# Streaming fragment'
const request = { preview, previous }

const streaming = {
  ...record, summary: preview, summaryState: 'generating', summaryError: undefined,
  summarySourceSignature: undefined, summarySourceVersionId: undefined,
  summaryTranslation: undefined, summaryTranslationTargetLanguage: undefined
}
const rolledBack = revertSummaryPreview(streaming, request)
assert.notEqual(rolledBack, streaming, 'the rollback produces a new record instead of mutating the snapshot')
assert.deepEqual({ summary: rolledBack.summary, summaryState: rolledBack.summaryState, summaryError: rolledBack.summaryError, summarySourceSignature: rolledBack.summarySourceSignature, summarySourceVersionId: rolledBack.summarySourceVersionId, summaryTranslation: rolledBack.summaryTranslation, summaryTranslationTargetLanguage: rolledBack.summaryTranslationTargetLanguage }, previous, 'a preview left behind by a request that never committed restores the captured summary and translation')
assert.equal(streaming.summary, preview, 'the input snapshot is untouched')

const rewritten = { ...record, summary: '# Written by a newer owner' }
assert.equal(revertSummaryPreview(rewritten, request), rewritten, 'a record another request already rewrote is never clobbered by a late rollback')

const neverWritten = { ...record, summary: undefined, summaryState: 'generating' }
assert.equal(revertSummaryPreview(neverWritten, request), neverWritten, 'a record this request never streamed into is left alone')

const noPreview = { ...record, summary: '# Previous summary', summaryState: 'interrupted' }
assert.equal(revertSummaryPreview(noPreview, { previous }), noPreview, 'a request without a streaming preview has nothing to roll back')

console.log('PASS summary preview rollback restores the captured summary only for the record the request actually streamed into')
