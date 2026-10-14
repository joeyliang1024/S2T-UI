const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { transformSync, buildSync } = require('esbuild')

// Exercise the controller action with both transports, without starting audio
// capture, a desktop window or an external model service.
const source = readFileSync('src/renderer/src/features/app/hooks/useAppController.ts', 'utf8')
const bundled = buildSync({ stdin: { contents: "export * from './src/renderer/src/features/summary/services/translate-summary'; export * from './src/renderer/src/features/translation/transports/web-text'; export * from './src/renderer/src/features/translation/transports/desktop-text';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',bundled)(m,m.exports,require)
const { translateSessionSummary, createWebTextPort, createDesktopTextPort } = m.exports
const settings = { selectedTranslationModelId: 'local-model', translationEndpoint: 'http://localhost:9000/v1', translationModel: 'translator', translationProfiles: [{ id: 'local-model', requiresApiKey: false }], glossary: '', targetLanguage: 'en' }
const entry = { id: 'session', summary: '# Notes\nHello' }
function makeAction(s2t, fetch, timers = {}, sourceLanguage = 'en-US') {
  let sessions = [entry]
  const window = { s2t, setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout }
  const binding = { id: 'local-model', endpoint: settings.translationEndpoint, model: settings.translationModel, requiresApiKey: false }
  const port = s2t ? createDesktopTextPort(binding, s2t, window) : createWebTextPort(binding, { clock: window, fetch: async (url, options) => {
    const response = await fetch(url, options)
    return new Response(JSON.stringify(await response.json()), { status: response.ok === false ? 502 : 200 })
  } })
  const generations = new Map()
  const translate = (entry, target = settings.targetLanguage) => translateSessionSummary(entry, { sourceLanguage, targetLanguage: target, glossary: '' }, {
    generations, complete: port.complete, emptyError: () => Error('stTranslationServiceEmpty'),
    publish: (entry, text, translated, targetLanguage) => { sessions = sessions.map(item => item.id === entry.id && item.summary === text ? { ...item, summaryTranslation: translated, summaryTranslationTargetLanguage: targetLanguage } : item) }
  })
  return { translate, sessions: () => sessions }
}
;(async () => {
  let request
  const desktop = makeAction({ completeText: async input => { request = input; return { text: '# 翻譯' } } }, () => { throw Error('desktop must use IPC') })
  await desktop.translate(entry, 'zh-TW')
  assert.equal(request.profileId, 'local-model')
  assert.equal(request.requiresApiKey, false)
  assert.match(request.messages[0].content, /Traditional Chinese|繁體中文/)
  assert.equal(desktop.sessions()[0].summaryTranslation, '# 翻譯')
  assert.equal(desktop.sessions()[0].summary, entry.summary)
  const web = makeAction(undefined, async (url, options) => {
    assert.equal(url, '/api/translations')
    assert.equal(JSON.parse(options.body).targetLanguage, 'ja')
    assert.equal(JSON.parse(options.body).format, 'markdown', 'summary structure must reach the gateway')
    return { ok: true, json: async () => ({ text: '日本語' }) }
  })
  await web.translate(entry, 'ja')
  assert.equal(web.sessions()[0].summaryTranslation, '日本語')
  const simplified = makeAction(undefined, async (url, options) => {
    assert.equal(JSON.parse(options.body).sourceLanguage, 'zh-CN', 'a zh-CN UI must not be sent as zh-TW')
    return { ok: true, json: async () => ({ text: '翻譯' }) }
  }, {}, 'zh-CN')
  await simplified.translate(entry, 'zh-TW')
  assert.equal(simplified.sessions()[0].summaryTranslation, '翻譯')
  const empty = makeAction({ completeText: async () => ({ text: '' }) })
  await assert.rejects(empty.translate(entry), /stTranslationServiceEmpty/)
  const timeout = makeAction(undefined, async (_url, options) => {
    assert.equal(options.signal.aborted, true)
    throw Error('signal is aborted without reason')
  }, { setTimeout: callback => { callback(); return 1 }, clearTimeout: () => {} })
  await assert.rejects(timeout.translate(entry), /timed out|timeout|逾時/i)
  assert.equal(timeout.sessions()[0].summary, entry.summary)
  const pending = []
  const racing = makeAction({ completeText: () => new Promise(resolve => pending.push(resolve)) })
  const old = racing.translate(entry, 'ja')
  const newer = racing.translate(entry, 'de')
  pending[1]({ text: 'Deutsch' }); await newer
  const latest = racing.translate(entry, 'zh-TW')
  pending[0]({ text: 'stale Japanese' }); await old
  assert.equal(racing.sessions()[0].summaryTranslation, 'Deutsch', 'a completed newer request cannot make a token reusable')
  pending[2]({ text: '最新中文' }); await latest
  assert.equal(racing.sessions()[0].summaryTranslation, '最新中文')
  assert.equal(racing.sessions()[0].summaryTranslationTargetLanguage, 'zh-TW')
  const gatewayAbort = makeAction(undefined, async () => ({ ok: false, json: async () => ({ error: 'signal is aborted without reason' }) }))
  await assert.rejects(gatewayAbort.translate(entry), /timed out|timeout|逾時/i)
  const manualAction = source.slice(source.indexOf('const requestTranslation ='), source.indexOf('const cancelPendingTranslations ='))
  const manualCode = transformSync(`${manualAction}\nreturn requestTranslation`, { loader: 'ts' }).code
  let requested = false
  const requestTranslation = new Function('useCallback', 'settings', 'window', 'setStatus', 'activeTranslate', 'groupLiveCaptions', 'transcriptsRef', 'translationQueueRef', 'translateCaption', 'translationReady', manualCode)(
    callback => callback, { ...settings, translationEnabled: false, translationStrategy: 'realtime' }, {},
    () => {}, key => key, () => [], { current: [] }, { current: { request: async () => { requested = true } } }, () => {}, false)
  await requestTranslation({ id: 'caption', sourceText: 'hello', status: 'final' })
  assert.equal(requested, true, 'an explicit translation must work when automatic translation is disabled')
  console.log('PASS summary translation uses desktop IPC or web API, preserves original, supports keyless profiles and reports retryable timeouts')
})().catch(error => { console.error(error); process.exitCode = 1 })
