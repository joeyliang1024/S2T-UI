const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const load = file => {
  const code = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'], write: false }).outputFiles[0].text
  const module = { exports: {} }; new Function('module', 'exports', 'require', code)(module, module.exports, require); return module.exports
}
const { comparisonRows, comparisonText } = load('src/renderer/src/features/quality-comparison/domain/comparison.ts')
const validate = (before, after) => {
  const rows = comparisonRows(before, after)
  assert.equal(rows.filter(row => row.before !== undefined).map(row => row.before).join('\n'), before)
  assert.equal(rows.filter(row => row.after !== undefined).map(row => row.after).join('\n'), after)
  return rows
}
assert.equal(validate('一\n二\n三', '一\n新增\n二\n三').filter(row => row.changed).length, 1)
assert.equal(validate('一\n移除\n二', '一\n二').find(row => row.before === '移除').after, undefined)
assert.equal(validate('台灣\nhello 😀', '臺灣\nhello 😀')[0].changed, true)
assert.equal(validate('', '').length, 0)
validate('', '新增'); validate('移除', ''); validate('a\n', '\na'); validate('a\na\nb', 'a\nb\na')
validate(Array.from({length: 600}, (_, i) => 'old ' + i).join('\n'), Array.from({length: 600}, (_, i) => 'new ' + i).join('\n'))
const base = { id: 'a', title: 'A', createdAt: '2026-10-17', durationMs: 1000, source: 'microphone', audioKey: 'audio', transcript: '新版', segments: [], activeAudioVersionId: 'new', audioVersions: [{ id: 'original', transcript: '最初' }, { id: 'prior', transcript: '舊版' }, { id: 'new', parentId: 'prior', transcript: '新版' }] }
assert.deepEqual(comparisonText(base), { before: '舊版', after: '新版', hasBaseline: true })
assert.equal(comparisonText({ ...base, audioVersions: undefined }).hasBaseline, false)
assert.equal(comparisonText({ ...base, audioVersions: undefined }).before, '新版')
const oldSegment = { id: 's', status: 'final', sourceText: '舊字幕', translatedText: 'Old translation', speaker: 'SPEAKER_01', startMs: 0, endMs: 2000 }
const newSegment = { ...oldSegment, sourceText: '新字幕', translatedText: 'New translation', speaker: 'SPEAKER_02' }
const withSegments = { ...base, segments: [newSegment], audioVersions: [{ id: 'prior', segments: [oldSegment] }, { id: 'new', parentId: 'prior', segments: [newSegment] }] }
const subtitle = comparisonText(withSegments, 'transcript')
assert.match(subtitle.before, /舊字幕/); assert.doesNotMatch(subtitle.before, /Old translation|SPEAKER/)
const speakers = comparisonText(withSegments, 'diarization')
assert.match(speakers.before, /SPEAKER_01/); assert.match(speakers.after, /SPEAKER_02/)
assert.doesNotMatch(speakers.after, /新字幕|translation/)
const translations = comparisonText(withSegments, 'translation')
assert.match(translations.before, /Old translation/); assert.match(translations.after, /New translation/)
assert.doesNotMatch(translations.after, /新字幕|SPEAKER/)
assert.equal(comparisonText(base, 'diarization').hasBaseline, false)
assert.equal(comparisonText(base, 'translation').after, '')
const compact = comparisonText({ ...withSegments, segments: [newSegment, { ...newSegment, id:'second', startMs:2000, endMs:3000 }] }, 'transcript')
assert.equal(compact.after.split('\n').length, 2, 'comparison segments use one row each without export paragraph spacers')
assert.doesNotMatch(compact.after, /\n\n/)
const preserved = comparisonText({ ...withSegments, segments:[{...newSegment,sourceText:'line one\nline two'}] }, 'transcript')
assert.match(preserved.after, /line one\nline two/, 'line breaks inside original content are retained')
const { QualityComparisonWorkspace } = load('src/renderer/src/features/quality-comparison/views/QualityComparisonWorkspace.tsx')
const props = { sessions: [base], progress: {}, correct: async () => {}, canCorrect: true, ui: key => key }
const render = changes => renderToStaticMarkup(React.createElement(QualityComparisonWorkspace, { ...props, ...changes }))
const html = render()
assert.match(html, /quality-diff-before/); assert.match(html, /quality-diff-after/)
assert.match(html.replace(/<[^>]+>/g, ''), /舊版/); assert.match(html.replace(/<[^>]+>/g, ''), /新版/)
const running = render({ progress: { a: { stage: 'asr', completed: 2, total: 5 } } })
assert.match(running, /<progress[^>]*max="5"[^>]*value="2"/)
assert.match(running, /<button[^>]*disabled/)
assert.match(render({ progress: { a: { stage: 'loading', completed: 0, total: 0 } } }), /<progress[^>]*max="1"><\/progress>/)
assert.match(render({ progress: { a: { stage: 'failed', completed: 1, total: 5, error: 'Test failure' } } }), /role="alert">Test failure/)
assert.match(render({ sessions: [] }), /noHistory/)
assert.match(render({ sessions: [base, {...base,id:'b',title:'Selected record B'}], sessionId:'b' }), /value="b" selected=""/)

assert.match(render({ canCorrect: false }), /<button[^>]*disabled/)
for (const stage of ['asr','translation','diarization','saving']) {
  const failed = { ...base, processingState:'failed', processingFailures:[stage], processingError:'prior failure', qualityCorrectionState:'failed', qualityCorrectionError:'old failure', segments:[{id:'segment',status:'final',sourceText:'usable transcript',startMs:0,endMs:1000}] }
  assert.doesNotMatch(render({sessions:[failed]}), /<button[^>]*disabled/, stage+' failure must allow correction with usable audio and captions')
  assert.match(render({sessions:[{...failed,processingState:'running'}]}), /<button[^>]*disabled/)
  assert.match(render({sessions:[{...failed,audioUnavailable:true}]}), /<button[^>]*disabled/)
}

assert.match(render({ sessions: [{ ...base, title: '<script>bad</script>' }] }), /&lt;script&gt;bad&lt;\/script&gt;/)
console.log('PASS diff alignment, insertions, deletions, Unicode, bounded large transcripts, immediate parent baseline, progress, failure and empty states')
