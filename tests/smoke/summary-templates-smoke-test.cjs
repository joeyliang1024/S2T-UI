const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/app/services/summary-templates.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('summary-templates-smoke-module')
loaded.filename = 'summary-templates-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { addSummaryTemplate, removeSelectedSummaryTemplate, selectSummaryTemplate, defaultCustomTemplate } = loaded.exports

const initial = [{ id: 'base', name: 'Base', content: '# Base' }]
const added = addSummaryTemplate(initial, 'custom', ' Custom ', '')
assert.equal(added.selectedSummaryTemplateId, 'custom')
assert.equal(added.summaryTemplate, defaultCustomTemplate)
assert.equal(selectSummaryTemplate(added.templates, 'base').summaryTemplate, '# Base')
assert.deepEqual(removeSelectedSummaryTemplate(added.templates, 'custom').templates, initial)
assert.throws(() => removeSelectedSummaryTemplate(initial, 'base'), /last-template/)
assert.throws(() => addSummaryTemplate(initial, 'invalid', ' ', '# body'), /template-name-required/)
console.log('Summary templates smoke test passed.')
