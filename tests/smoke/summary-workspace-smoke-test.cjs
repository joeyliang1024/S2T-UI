const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const code = buildSync({ entryPoints: ['src/renderer/src/features/summary/views/SummaryWorkspace.tsx'], bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'], write: false }).outputFiles[0].text
// Render the real component and invoke its event handlers with deterministic
// hook storage; no network, audio devices or external browser are needed.
let hooks = [], cursor = 0, effects = [], dirty = false
const react = {
  useState(initial) {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = initial
    return [hooks[index], value => { const next = typeof value === 'function' ? value(hooks[index]) : value; if (next !== hooks[index]) { hooks[index] = next; dirty = true } }]
  },
  useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial } },
  useEffect(callback, deps) {
    const index = cursor++
    if (!hooks[index] || deps.some((dep, i) => dep !== hooks[index][i])) { hooks[index] = deps; effects.push(callback) }
  }
}
const jsx = (type, props) => ({ type, props })
const m = { exports: {} }
new Function('module', 'exports', 'require', code)(m, m.exports, name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx, Fragment: 'fragment' } : require(name))
global.window = {}
const calls = [], cancellations = []
const session = { id: 'a', title: 'A', summary: 'Original A', transcript: 'transcript', segments: [], createdAt: '2026-10-13', processingState: 'failed', processingError: 'translation failure' }
let props = {
  generatingIds: [], ui: key => key, sessions: [session, { ...session, id: 'b', title: 'B', summary: 'Original B' }], sessionId: 'a',
  settings: { uiLanguage: 'en', targetLanguage: 'ja', summaryTemplates: [], summaryTemplate: '' },
  setSessionId: () => {}, selectTemplate: () => {}, openSettings: () => {}, summarizeSession: async () => {}, cancelSummary: id => cancellations.push(id), copySummary: async () => {}, openSummaryDownload: () => {},
  translateSummary: (_session, target) => new Promise((resolve, reject) => calls.push({ id: _session.id, target, resolve, reject }))
}
let tree
function render() {
  do { dirty = false; cursor = 0; effects = []; tree = m.exports.SummaryWorkspace(props); effects.forEach(effect => effect()) } while (dirty)
  return tree
}
function nodes(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(nodes); return [node, ...[].concat(node.props?.children || []).flatMap(nodes)] }
function button(label) { return nodes(tree).find(node => node.type === 'button' && node.props.children === label) }
function targetSelect() { return nodes(tree).find(node => node.type === 'select' && node.props.value === (hooks[3] || 'ja')) }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); render() }
;(async () => {
  render()
  assert.equal(button('generateSummary').props.disabled, false, 'a translation failure cannot disable summary generation')
  props = { ...props, generatingIds: ['a'], sessions: [{ ...session, summaryState: 'generating' }, props.sessions[1]] }; render()
  assert.ok(button('cancelSummary'), 'generation replaces both generate and regenerate with a cancel action')
  button('cancelSummary').props.onClick()
  assert.deepEqual(cancellations, ['a'])
  props = { ...props, generatingIds: [], sessions: [session, props.sessions[1]] }; render()
  assert.ok(button('generateSummary'), 'after cancellation the retained summary can be regenerated again')
  button('translateSummary').props.onClick(); render()
  // Switching tabs or languages must not fire the request; an explicit
  // button triggers the translation instead.
  assert.equal(calls.length, 0, 'opening the tab does not auto-translate')
  assert.ok(button('generateSummary'), 'one shared generate button is available')
  button('generateSummary').props.onClick(); render()
  assert.equal(calls.length, 1)
  assert.ok(nodes(tree).some(node => node.props?.role === 'status' && node.props.children === 'summaryTranslating'))
  calls[0].reject(Error('timeout')); await flush()
  assert.ok(nodes(tree).some(node => node.props?.role === 'alert'))
  button('generateSummary').props.onClick(); render()
  assert.equal(calls.length, 2)
  targetSelect().props.onChange({ target: { value: 'de' } }); render()
  assert.equal(calls.length, 2, 'changing the target language does not auto-translate')
  button('generateSummary').props.onClick(); render()
  assert.equal(calls.length, 3)
  calls[1].reject(Error('stale timeout')); await flush()
  assert.ok(nodes(tree).some(node => node.props?.role === 'status' && node.props.children === 'summaryTranslating'), 'old failure must not clear new loading state')
  assert.ok(!nodes(tree).some(node => node.props?.role === 'alert'), 'old failure must not display in a new target')
  props = { ...props, sessionId: 'b' }; render()
  calls[2].reject(Error('old session error')); await flush()
  assert.ok(!nodes(tree).some(node => node.props?.role === 'alert'), 'old session cannot set the new session error')
  props.sessions[1] = { ...props.sessions[1], summaryTranslation: 'Old German', summaryTranslationTargetLanguage: 'de' }
  render(); button('translateSummary').props.onClick(); render()
  // The cached translation is for another language: show the button, wait.
  assert.equal(calls.length, 3, 'a cached translation for a different language waits for the explicit button')
  button('generateSummary').props.onClick(); render()
  assert.equal(calls.length, 4)
  calls[3].resolve(); await flush()
  console.log('PASS summary workspace translates only on explicit click, keeps failure/retry, guards target and session races, validates cached language and permits summaries after translation failure')
})().catch(error => { console.error(error); process.exitCode = 1 })
