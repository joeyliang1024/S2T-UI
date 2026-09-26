const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/features/models/model-adapter.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('model-adapter-smoke-module')
loaded.filename = 'model-adapter-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { OpenAiChunkedModelAdapter } = loaded.exports

const main = async () => {
  let keyChecks = 0
  global.window = { s2t: { hasModelApiKey: async () => { keyChecks += 1; return false } } }
  const noKey = new OpenAiChunkedModelAdapter({ id: 'local-asr', endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: 'local', requiresApiKey: false })
  await noKey.start({ sampleRate: 16_000, language: 'auto', targetLanguage: 'en' })
  assert.equal(keyChecks, 0, 'keyless models must not require a stored key')
  const requiresKey = new OpenAiChunkedModelAdapter({ id: 'protected-asr', endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: 'protected', requiresApiKey: true })
  await assert.rejects(requiresKey.start({ sampleRate: 16_000, language: 'auto', targetLanguage: 'en' }), /API key/)
  assert.equal(keyChecks, 1)
  console.log('Model adapter smoke test passed.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
