const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const code = buildSync({ entryPoints: ['src/renderer/src/features/sessions/domain/history.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const moduleValue = { exports: {} }
new Function('module', 'exports', 'require', code)(moduleValue, moduleValue.exports, require)
const { sessionHistory } = moduleValue.exports
const entry = (id, title, durationMs, text = '') => ({ id, title, durationMs, createdAt: '2026-10-17T00:00:00Z', source: 'microphone', transcript: text, segments: [] })
const rows = [entry('a', 'Zulu', 30), entry('b', 'Äpfel', 10), { ...entry('c', 'alpha', 20), segments: [{ speaker: 'Speaker Lee', sourceText: 'original', translatedText: 'übersetzt' }] }]
const options = { search: '', sort: 'title', direction: 'asc', page: 1, pageSize: 2, locale: 'de' }
const before = JSON.stringify(rows)
assert.deepEqual(sessionHistory(rows, options).pagedSessions.map(row => row.id), ['c', 'b'])
assert.deepEqual(sessionHistory(rows, { ...options, locale: 'sv' }).pagedSessions.map(row => row.id), ['c', 'a'], 'sorting uses the supplied display locale')
assert.deepEqual(sessionHistory(rows, { ...options, search: 'LEE' }).filteredSessions.map(row => row.id), ['c'])
assert.deepEqual(sessionHistory(rows, { ...options, search: 'ÜBERSETZT' }).filteredSessions.map(row => row.id), ['c'])
assert.deepEqual(sessionHistory(rows, { ...options, sort: 'durationMs', direction: 'desc', page: 2 }).pagedSessions.map(row => row.id), ['b'])
assert.equal(sessionHistory(rows, { ...options, page: 99 }).currentHistoryPage, 2)
const empty = sessionHistory([], { ...options, page: -1 })
assert.equal(empty.currentHistoryPage, 1); assert.equal(empty.historyPageCount, 1); assert.deepEqual(empty.pagedSessions, [])
assert.equal(JSON.stringify(rows), before, 'derivation never mutates the stored snapshot')
console.log('PASS session history: display locale, speaker/translation search, sort direction, pagination, empty/clamped pages and immutable snapshots')
