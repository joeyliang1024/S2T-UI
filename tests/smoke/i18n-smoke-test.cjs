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
