const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { buildSync } = require('esbuild')
const transpile = require('../helpers/transpile-typescript.cjs')
const code = buildSync({ stdin: { contents: `export * from './frontend/src/features/transcript/services/quality-correction'; export * from './frontend/src/features/transcript/domain/live-caption'; export * from './frontend/src/shared/services/audio'; export * from './frontend/src/features/transcript/wav-batch'; export * from './frontend/src/features/transcript/views/CorrectedText';`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] }).outputFiles[0].text
const mod = { exports: {} }; new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
const { correctionGroups, correctedCaption, applySentenceCorrection, correctionRuns, CorrectionAudioBuffer, captionGroupSignature, makeWav, readPcmWavFileLayout, readPcmWavSentence, CorrectedText } = mod.exports
const caption = (id, startMs, endMs, sourceText, closed = false) => ({ id, startMs, endMs, sourceText, status: 'final', revision: 1, isSentenceBoundary: closed })
const entries = [caption('a', 0, 2000, '今天討論'), caption('b', 2000, 4000, '模型部署'), caption('c', 4000, 6000, '與成本。', true)]
const group = correctionGroups(entries)[0]
assert.equal(correctionGroups(entries).length, 1, 'one merged caption row is one correction unit')
assert.equal(group.members.length, 3)
// The display never shows more than ten seconds per row, so correction must
// follow those rows instead of collapsing the whole stretch into one caption.
const long = [caption('a', 0, 6000, '今天討論'), caption('b', 6000, 12000, '模型部署'), caption('c', 12000, 18000, '與成本。', true)]
const longRows = correctionGroups(long, true)
assert.equal(longRows.length, 3, 'a whole sentence exceeding the ten-second display limit stays three rows')
let rowByRow = long
for (const row of longRows) rowByRow = applySentenceCorrection(rowByRow, row, row.sourceText)
assert.equal(rowByRow.length, 3, 'correcting row by row never merges caption rows')
assert.deepEqual(rowByRow.map(entry => entry.captionGroupId), ['a', 'b', 'c'], 'each corrected row keeps its own display lock')
assert.equal(correctionGroups([caption('open', 0, 5000, '尚未說完')]).length, 0, 'open tail waits')
const replaced = applySentenceCorrection(entries, group, '今天討論模型部署與效能。')
assert.equal(replaced.length, 1)
assert.equal(replaced[0].startMs, 0); assert.equal(replaced[0].endMs, 6000)
assert.equal(replaced[0].correctionOriginalText, group.sourceText)
assert.equal(replaced[0].translatedText, undefined)
const edited = entries.map(entry => entry.id === 'b' ? { ...entry, sourceText: '手動修改', revision: 2 } : entry)
assert.equal(applySentenceCorrection(edited, group, '舊結果'), edited, 'do not overwrite an edit made during ASR')
const translated = entries.map(entry => ({ ...entry, translatedText: 'done', translationStatus: 'completed', revision: entry.revision + 1 }))
const afterTranslation = applySentenceCorrection(translated, group, '今天討論模型部署與效能。')
assert.equal(afterTranslation.length, 1, 'translation completion must not permanently skip quality correction')
assert.equal(afterTranslation[0].translatedText, undefined, 'changed source invalidates old translation')
const latestSpeaker = entries.map(entry => entry.id === 'b' ? { ...entry, speaker: 'Alice', speakerManuallyEdited: true } : entry)
const labelled = applySentenceCorrection(latestSpeaker, group, '今天討論模型部署與效能。')
assert.equal(labelled[0].speaker, 'Alice'); assert.equal(labelled[0].speakerManuallyEdited, true)
assert.equal(correctionGroups([caption('p1', 0, 1000, '前半'), { ...caption('p2', 1000, 2000, '後半', true), speakerManuallyEdited: true }]).length, 1, 'correction follows the single visible row even for a manually blank speaker')
const tail = new CorrectionAudioBuffer(16000)
tail.push(new Float32Array(3128).fill(.1))
assert.equal(tail.slice(0, 196).length, 3128, 'rounded ASR endpoint may exceed actual samples by less than 1ms')
assert.equal(tail.slice(0, 198), null, 'larger missing audio must not be truncated')
const compacted = new CorrectionAudioBuffer(10, 1)
for (let index = 0; index < 10000; index++) compacted.push(new Float32Array([index]))
assert.deepEqual(Array.from(compacted.slice(999000, 1000000)), Array.from({length:10},(_,index)=>9990+index), 'audio remains exact after buffer compaction')
assert.equal(compacted.slice(0, 100), null)
assert.deepEqual(correctionRuns('今天天氣好', '今天天氣很好').filter(run => run.changed).map(run => run.text), ['很'])
assert.ok(correctionRuns('成本', '效能').every(run => run.changed))
assert.ok(correctionRuns('same', 'same').every(run => !run.changed))
const render = require('react-dom/server').renderToStaticMarkup
const html = render(require('react').createElement(CorrectedText, { text: '今天天氣很好', original: '今天天氣好' }))
assert.match(html, /<mark class="correction-highlight">很<\/mark>/)
assert.doesNotMatch(html, /<mark[^>]*>今天/)
// Render the production history preview, with editing details collapsed.
const viewSource = readFileSync('frontend/src/features/app/views/AppView.tsx', 'utf8')
const previewSource = 'const sessionViewTranslation = null; const sessionViewLanguage = \'zh-TW\';\n' + viewSource.slice(viewSource.indexOf('const sessionTranscript ='), viewSource.indexOf('const liveCaptionGroups ='))
const previewBundle = buildSync({ stdin: { contents: `import React from 'react'; import { CorrectedCaptionText } from './frontend/src/features/transcript/views/CorrectedText'; import { groupLiveCaptions } from './frontend/src/features/transcript/domain/live-caption'; import { searchCaptionGroups } from './frontend/src/features/transcript/domain/search'; import { createTextSearch } from './frontend/src/shared/services/search'; const timestamp = value => String(value); const ui = value => value; const canManageFeatures = false; const editingSessionSegmentId = null; const CaptionMemberDetails = () => null; ${previewSource}; export { sessionTranscript };`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] }).outputFiles[0].text
const previewModule = { exports: {} }; new Function('module', 'exports', 'require', previewBundle)(previewModule, previewModule.exports, require)
const savedPreview = render(previewModule.exports.sessionTranscript({ segments: [correctedCaption(correctionGroups([caption('saved', 0, 1000, '今天天氣好', true)])[0], '今天天氣很好')] }, ''))
assert.match(savedPreview, /今天天氣很好/, 'history displays the latest text without legacy comparison highlights')
assert.doesNotMatch(savedPreview, /<mark/)
const legacy = { segments: [], transcript: 'Legacy HELLO transcript' }
assert.match(render(previewModule.exports.sessionTranscript(legacy, ' ＨＥＬＬＯ ')), /Legacy HELLO transcript/)
const legacyMiss = render(previewModule.exports.sessionTranscript(legacy, 'missing'))
assert.doesNotMatch(legacyMiss, /Legacy HELLO transcript/)
assert.match(legacyMiss, /noSearchMatches/)
assert.match(render(previewModule.exports.sessionTranscript({segments:[caption('search',0,1000,'content',true)]}, 'missing')), /noSearchMatches/)

async function modelRouting() {
  const hook = readFileSync('frontend/src/features/app/hooks/useAppController.ts', 'utf8')
  const source = hook.slice(hook.indexOf('const transcribeCorrection ='), hook.indexOf('liveCorrectionRunnerRef.current = async'))
  const js = transpile(source).code
  const calls = []
  const context = { selectedModel: { id: 'selected', model: 'new' }, settings: { sourceLanguage: 'zh-TW', glossary: 'new prompt' },
    gatewayAsrProfileId: id => id, window: {}, asrLanguage: language => language, headerValue: text => text,
    requestBrowserAsr: async init => { calls.push(init); return new Response(JSON.stringify({text:'ok'})) }, readJsonResponse: response => response.json(), activeTranslate: key => key }
  const transcribe = new Function(...Object.keys(context), js + '; return transcribeCorrection')(...Object.values(context))
  await transcribe(new ArrayBuffer(4), { id:'capture', model:'original' }, 'en-US', 'capture glossary')
  assert.equal(calls[0].headers['x-s2t-model-id'], 'capture', 'route correction to the active capture model')
  assert.equal(calls[0].headers['x-s2t-language'], 'en-US')
  assert.equal(calls[0].headers['x-s2t-prompt'], 'capture glossary')
}
const ref = current => ({ current })
async function live(stale = false, edit = false) {
  const buffer = new CorrectionAudioBuffer(16000)
  buffer.push(new Float32Array(16000 * 29))
  let requests = 0, resolve
  const pending = new Promise(r => { resolve = r })
  const context = { liveCorrectionAudioRef: ref(buffer), activeModelSnapshotRef: ref({ kind: 'openai-http' }), isFloatingCaptionWindow: false,
    liveCorrectionBusyRef: ref(false), captureState: 'recording', liveCorrectionEpochRef: ref(1), continuationTargetRef: ref(null), transcriptsRef: ref(entries),
    liveCorrectionDoneRef: ref(new Set()), liveCorrectionFailuresRef: ref(new Map()), liveCorrectionRunnerRef: ref(null), correctionGroups, captionGroupSignature,
    selectedModel: {}, makeWav, applySentenceCorrection, transcribeCorrection: async () => { requests++; await pending; return { text: '今天討論模型部署與效能。' } },
    setStatus: () => {}, activeTranslate: x => x }
  context.setTranscripts = fn => { context.transcriptsRef.current = fn(context.transcriptsRef.current) }
  const hook = readFileSync('frontend/src/features/app/hooks/useAppController.ts', 'utf8')
  const start = hook.indexOf('liveCorrectionRunnerRef.current = async')
  const source = hook.slice(start, hook.indexOf('\nuseEffect(', start))
  const js = transpile(source).code
  new Function(...Object.keys(context), js)(...Object.values(context))
  await context.liveCorrectionRunnerRef.current(); assert.equal(requests, 0, 'no correction before 30 seconds')
  buffer.push(new Float32Array(16000))
  const task = context.liveCorrectionRunnerRef.current()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(requests, 1, 'correction starts at 30 seconds')
  await context.liveCorrectionRunnerRef.current(); assert.equal(requests, 1, 'only one background request at a time')
  if (stale) context.liveCorrectionEpochRef.current++
  if (edit) context.transcriptsRef.current = edited
  resolve(); await task
  assert.equal(context.transcriptsRef.current.length, stale || edit ? 3 : 1)
  if (!stale && !edit) { await context.liveCorrectionRunnerRef.current(); assert.equal(requests, 1, 'completed sentence is not corrected again') }
}
(async () => {
  const wav = makeWav([new Float32Array(16000 * 60)], 16000)
  const file = new File([wav], 'test.wav')
  const layout = await readPcmWavFileLayout(file)
  const sentence = await readPcmWavSentence(file, layout, 12000, 18000)
  assert.equal(sentence.startMs, 12000); assert.equal(sentence.endMs, 18000)
  assert.equal((sentence.audio.byteLength - 44) / 2, 16000 * 6, 'ASR receives the sentence span instead of 45 seconds')
  for (const [rate, frames] of [[16000, 1001], [44100, 3], [48000, 59]]) {
    const exactFile = new File([makeWav([new Float32Array(frames * 2)], rate)], 'exact.wav')
    const exactLayout = await readPcmWavFileLayout(exactFile)
    const exactSlice = await readPcmWavSentence(exactFile, exactLayout, 0, frames / rate * 1000)
    assert.equal((exactSlice.audio.byteLength - 44) / 2, frames, 'sentence slicing must not lose a frame through duration conversion')
  }
  const ring = new CorrectionAudioBuffer(10, 3)
  ring.push(new Float32Array(20).fill(1)); ring.push(new Float32Array(20).fill(2)); ring.push(new Float32Array(20).fill(3))
  assert.equal(ring.slice(0, 1000), null, 'expired audio is not silently truncated')
  assert.deepEqual(Array.from(ring.slice(3000, 5000)), [...new Array(10).fill(2), ...new Array(10).fill(3)])
  await modelRouting(); await live(); await live(true); await live(false, true)
  console.log('Sentence correction passed: whole sentences, exact audio spans, 30s start, one background worker, stale/edit guards, translation invalidation and changed-character highlights.')
})().catch(error => { console.error(error); process.exitCode = 1 })
