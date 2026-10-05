const assert = require('node:assert/strict')
const { readFile, mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { buildSync } = require('esbuild')
const { createStorage } = require('../../server/storage/index.cjs')
const code = buildSync({ entryPoints: ['src/renderer/src/features/app/services/environment-settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = { exports: {} }
new Function('module', 'exports', 'require', code)(m, m.exports, require)
const { applyEnvironmentSettings } = m.exports
async function main() {
  const config = JSON.parse(await readFile(process.argv[2] || '/private/tmp/s2t-environment-simulation-config.json', 'utf8'))
  assert.ok(config.asrProfiles.some(p => p.configured), 'Docker environment ASR must be configured')
  assert.ok(config.translation.configured && config.diarization.configured)
  const directory = await mkdtemp(join(tmpdir(), 's2t-model-recovery-'))
  const reports = []
  try {
    const storage = createStorage({ S2T_LOCAL_DATA_DIR: directory })
    await storage.ready
    const sessions = { version: 7, sessions: [{ id: 'existing-record', title: 'Existing recording', transcript: '這份紀錄必須保留', segments: [], audioKey: 'existing-audio' }] }
    await storage.config.put('simulation-user', 'sessions', sessions)
    const brokenProfiles = { modelProfiles: [{ id: 'lost-user-asr', name: 'Old user ASR', endpoint: 'http://obsolete.invalid/asr', model: 'old-asr', kind: 'openai-http' }], selectedModelId: 'missing-id', translationProfiles: [{ id: 'lost-user-translation', name: 'Old translation', endpoint: 'http://obsolete.invalid/chat/completions', model: 'old-translation' }], selectedTranslationModelId: 'missing-id', translationEndpoint: 'http://obsolete.invalid', translationModel: 'wrong', summaryEndpoint: 'http://obsolete.invalid', summaryModel: 'wrong', diarizationEndpoint: 'http://obsolete.invalid', diarizationModel: 'wrong' }
    const cases = [
      ['全部遺失', {}],
      ['清單清空／選擇失效', { modelProfiles: [], translationProfiles: [], selectedModelId: 'gone', selectedTranslationModelId: 'gone' }],
      ['端點與模型過期', brokenProfiles],
      ['資料型別損壞', { modelProfiles: { broken: true }, translationProfiles: [null, 42, { id: 7 }], translationEndpoint: 42, summaryEndpoint: [], summaryModel: null, diarizationModel: {} }]
    ]
    for (const [scenario, settings] of cases) {
      await storage.config.put('simulation-user', 'settings', { version: 1, settings })
      const loaded = await storage.config.get('simulation-user', 'settings')
      const restored = applyEnvironmentSettings(loaded.settings, config, false)
      const asr = restored.modelProfiles.find(p => p.id === restored.selectedModelId)
      const translation = restored.translationProfiles.find(p => p.id === restored.selectedTranslationModelId)
      assert.ok(asr.id.startsWith('web-'))
      assert.equal(translation.id, 'web-environment-translation')
      assert.equal(translation.model, config.translation.model)
      assert.equal(restored.translationEndpoint, translation.endpoint)
      if (config.summary.configured) {
        assert.equal(restored.summaryEndpoint, config.summary.endpoint)
        assert.equal(restored.summaryModel, config.summary.model)
      }
      assert.equal(restored.diarizationEndpoint, config.diarization.endpoint)
      assert.equal(restored.diarizationModel, config.diarization.model)
      if (scenario === '端點與模型過期') {
        assert.equal(restored.modelProfiles.find(p => p.id === 'lost-user-asr').endpoint, brokenProfiles.modelProfiles[0].endpoint)
        assert.equal(restored.translationProfiles.find(p => p.id === 'lost-user-translation').model, 'old-translation')
      }
      await storage.config.put('simulation-user', 'settings', { version: 2, settings: restored })
      const roundtrip = applyEnvironmentSettings((await storage.config.get('simulation-user', 'settings')).settings, config, false)
      assert.equal(roundtrip.selectedModelId, restored.selectedModelId)
      assert.deepEqual(await storage.config.get('simulation-user', 'sessions'), sessions)
      reports.push({ scenario, passed: true, asr: asr.model, translation: translation.model, summary: config.summary.configured ? restored.summaryModel : '環境未配置，無法恢復摘要預設', diarization: restored.diarizationModel, recordsUnchanged: true })
    }
    await mkdir('tmp/environment-recovery', { recursive: true })
    await writeFile('tmp/environment-recovery/results.json', JSON.stringify({ source: 'Running Docker /api/config', storage: 'Isolated local storage adapter', scenarios: reports }, null, 2))
    console.log(JSON.stringify(reports, null, 2))
  } finally { await rm(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
