const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/shared/i18n/index.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('i18n-smoke-module')
loaded.filename = 'i18n-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { supportedUiLanguages, interfaceMessageKeys, interfaceTranslate, authMessageKeys, authTranslate, messageKeys, translate } = loaded.exports

for (const language of supportedUiLanguages) {
  for (const key of interfaceMessageKeys) assert.ok(interfaceTranslate(language, key).trim(), `${language}:${key} must be translated`)
  for (const key of authMessageKeys) assert.ok(authTranslate(language, key).trim(), `${language}:${key} must be translated`)
  for (const key of messageKeys) assert.ok(translate(language, key).trim(), `${language}:${key} must be translated`)
}
assert.notEqual(interfaceTranslate('en', 'waitingForSpeech'), interfaceTranslate('zh-TW', 'waitingForSpeech'))
assert.notEqual(authTranslate('ja', 'department'), authTranslate('en', 'department'))
console.log('I18n smoke test passed.')

// Each context starts with a fresh language cache, as a new renderer would.
const { runInNewContext } = require('node:vm')
for (const [tags, expected] of [[['zh-TW'], 'zh-TW'], [['zh-Hans-CN'], 'zh-CN'], [['ja-JP'], 'ja'], [['de-DE'], 'de'], [['fr-FR'], 'en'], [['zh_Hant_TW'], 'zh-TW']]) {
  const context = { exports: {}, module: { exports: {} }, window: { s2t: { systemLanguages: tags } }, navigator: { languages: ['en-US'] } }
  context.exports = context.module.exports
  runInNewContext(result.outputFiles[0].text, context)
  assert.equal(context.module.exports.resolveUiLanguage('system'), expected, `native ${tags} overrides Chromium English`)
  assert.equal(context.module.exports.resolveUiLanguage('de'), 'de', 'explicit preference overrides system')
}
const browserContext = { module: { exports: {} }, navigator: { languages: ['ja-JP'] } }
browserContext.exports = browserContext.module.exports
runInNewContext(result.outputFiles[0].text, browserContext)
assert.equal(browserContext.module.exports.resolveUiLanguage('system'), 'ja', 'web keeps browser language detection')
