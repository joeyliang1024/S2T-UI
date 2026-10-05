const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const code = buildSync({ entryPoints: ['src/renderer/src/features/app/services/environment-settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = { exports: {} }
new Function('module', 'exports', 'require', code)(m, m.exports, require)
const { applyEnvironmentSettings } = m.exports
const account = {
  modelProfiles: [{ id: 'user-asr', name: 'User ASR', endpoint: 'https://user/asr', model: 'shared-name', kind: 'openai-http', requiresApiKey: false }],
  selectedModelId: 'user-asr',
  translationProfiles: [{ id: 'user-translation', name: 'User translation', endpoint: 'https://user/translation', model: 'shared-name', requiresApiKey: false }],
  selectedTranslationModelId: 'user-translation',
  summaryEndpoint: 'https://user/summary', summaryModel: 'user-summary',
  diarizationEndpoint: 'https://user/diarization', diarizationModel: 'user-diarization'
}
const config = {
  asr: { endpoint: '/api/transcriptions', sourceEndpoint: 'https://env/asr', model: 'shared-name', configured: true },
  translation: { endpoint: '/api/translations', sourceEndpoint: 'https://env/translation', model: 'shared-name', configured: true },
  summary: { endpoint: '/api/summaries', model: 'env-summary', configured: true },
  diarization: { endpoint: '/api/diarizations', model: 'env-diarization', configured: true }
}
for (const desktop of [false, true]) {
  const loaded = applyEnvironmentSettings(account, config, desktop)
  assert.equal(loaded.selectedModelId, desktop ? 'environment-asr' : 'web-environment-asr')
  assert.equal(loaded.selectedTranslationModelId, desktop ? 'environment-translation' : 'web-environment-translation')
  assert.equal(loaded.modelProfiles.find(p => p.id === 'user-asr').endpoint, 'https://user/asr')
  assert.deepEqual(loaded.translationProfiles.find(p => p.id === 'user-translation'), account.translationProfiles[0])
  assert.equal(loaded.summaryEndpoint, '/api/summaries')
  assert.equal(loaded.diarizationModel, 'env-diarization')
  assert.equal(loaded.translationEndpoint, 'https://env/translation')
  const registryLoaded = applyEnvironmentSettings({ ...loaded, summaryEndpoint: 'https://user/summary', summaryModel: 'user-summary', selectedModelId: 'user-asr' }, config, desktop)
  assert.equal(registryLoaded.summaryModel, 'env-summary', 'account registry cannot overwrite environment settings')
  assert.equal(registryLoaded.selectedModelId, loaded.selectedModelId)
  assert.equal(registryLoaded.modelProfiles.length, loaded.modelProfiles.length, 'environment profiles are not duplicated')
}
const unavailable = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, { ...value, configured: false }]))
const fallback = applyEnvironmentSettings(account, unavailable, false)
assert.equal(fallback.selectedModelId, 'user-asr')
assert.equal(fallback.selectedTranslationModelId, 'user-translation')
assert.equal(fallback.summaryEndpoint, account.summaryEndpoint)
assert.equal(fallback.diarizationEndpoint, account.diarizationEndpoint)
const catalog = applyEnvironmentSettings(account, { ...config, asrProfiles: [{ id: 'default', name: 'Default', endpoint: '/api/transcriptions', model: 'default', configured: true }, { id: 'secondary', name: 'Secondary', endpoint: '/api/transcriptions', model: 'second', configured: true }] }, false)
assert.equal(catalog.selectedModelId, 'web-environment-asr')
assert.equal(catalog.modelProfiles.length, 3)
console.log('Environment settings: defaults, user model preservation, registry precedence and unavailable environment fallback passed.')

const both = applyEnvironmentSettings(account, { ...config, diarizationProfiles: [ { id:'local-sherpa-onnx-speaker-diarization', name:'Sherpa', model:'sherpa-onnx-speaker-diarization', endpoint:'/api/diarizations', configured:true }, { id:'local-nemotron-3-diarization', name:'Nemotron', model:'nemotron-3-diarization', endpoint:'/api/diarizations', configured:true } ], diarization:{endpoint:'/api/diarizations',model:'nemotron-3-diarization',configured:true} }, false)
assert.equal(both.diarizationProfiles.filter(p=>p.id.startsWith('local-')).length,2)
assert.equal(both.diarizationModel,'nemotron-3-diarization')
assert.ok(both.diarizationProfiles.some(p=>p.endpoint===account.diarizationEndpoint))
console.log('Both local diarization models are listed; environment selects only the default; user model remains available.')
