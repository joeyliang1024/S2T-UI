const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const code = buildSync({
  entryPoints: ['frontend/src/features/sessions/services/remote-session-storage.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['../../auth/services/auth-client', '../../../shared/i18n']
}).outputFiles[0].text
const moduleValue = { exports: {} }
new Function('module', 'exports', 'require', code)(moduleValue, moduleValue.exports, id => id.includes('auth-client')
  ? { retryableAuthFetch: (...args) => globalThis.__remoteResponseFetch(...args) }
  : { activeTranslate: key => key })
const { remoteSessionStorage } = moduleValue.exports

const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const segment = { id: 'caption-1', revision: 1, status: 'final', startMs: 0, endMs: 1200, sourceText: 'legacy-compatible transcript' }
const legacySession = { id: 'session-1', title: 'Legacy session', createdAt: '2026-10-17T00:00:00.000Z', durationMs: 1200, source: 'microphone', transcript: segment.sourceText, segments: [segment] }
const legacySessionLoaded = { ...legacySession, audioKey: '' }
const modelSnapshot = { id: 'none', name: '', endpoint: '', model: '', kind: 'websocket', requiresApiKey: true, capabilities: { asrMode: 'streaming', vadSource: 'app', timestampPrecision: 'segment', supportedLanguages: ['zh-TW'], supportedSampleRates: [16000] }, sourceLanguage: 'zh-TW', prompt: '', inputSampleRate: 48000, modelSampleRate: 16000 }
const currentSession = { ...legacySessionLoaded, modelSnapshot, audioVersions: [{ id: 'original', audioKey: 'audio-1', createdAt: legacySession.createdAt, label: 'Original', segments: [segment], transcript: segment.sourceText, modelSnapshot }], activeAudioVersionId: 'original', processingState: 'completed', processingFailures: [], summaryState: 'generating' }
const draft = { id: 'draft-1', startedAt: legacySession.createdAt, updatedAt: legacySession.createdAt, captureState: 'paused', source: 'microphone', elapsedMs: 1200, segments: [segment], opfsRecordingId: 'opfs-1', sampleRate: 48000 }
const checkpoint = { fingerprint: 'meeting.wav:12:1', modelId: 'asr-1', modelSnapshot: JSON.stringify(modelSnapshot), sourceLanguage: 'zh-TW', prompt: 'terms', nextChunkIndex: 1, nextByteOffset: 2048, totalChunks: 2, segments: [segment], mergedText: segment.sourceText, updatedAt: legacySession.createdAt }

;(async () => {
  const calls = []
  const queue = []
  globalThis.__remoteResponseFetch = async path => {
    calls.push(path)
    if (!queue.length) throw new Error(`missing fixture for ${path}`)
    return response(queue.shift())
  }

  queue.push({ sessions: [legacySession, currentSession], version: 7 })
  assert.deepEqual(await remoteSessionStorage.load(), { sessions: [legacySessionLoaded, currentSession], version: 7 }, 'legacy records may omit newer optional fields and old audio references')

  queue.push({ value: undefined }, { value: null }, { value: draft }, { value: undefined }, { value: checkpoint })
  assert.equal(await remoteSessionStorage.loadLiveDraft(), undefined, 'missing live draft is normal')
  assert.equal(await remoteSessionStorage.loadLiveDraft(), undefined, 'null live draft is normal')
  assert.deepEqual(await remoteSessionStorage.loadLiveDraft(), draft)
  assert.equal(await remoteSessionStorage.loadImportCheckpoint(), undefined, 'missing import checkpoint is normal')
  assert.deepEqual(await remoteSessionStorage.loadImportCheckpoint(), checkpoint)

  queue.push({ sessions: [legacySession] })
  await assert.rejects(remoteSessionStorage.load(), /response\.version/)
  queue.push({ sessions: [{ ...legacySession, segments: [{ ...segment, endMs: -1 }] }], version: 8 })
  await assert.rejects(remoteSessionStorage.load(), /endMs/)
  queue.push({ sessions: [{ ...legacySession, audioVersions: [{ id: 'audio', audioKey: 'audio', createdAt: 'now', label: 'audio', segments: 'not-an-array' }] }], version: 8 })
  await assert.rejects(remoteSessionStorage.load(), /audioVersions\[0\]\.segments/)
  queue.push({ sessions: [{ ...legacySessionLoaded, summaryState: 'finished' }], version: 8 })
  await assert.rejects(remoteSessionStorage.load(), /summaryState/)
  queue.push({ value: { ...draft, captureState: 'stopped' } })
  await assert.rejects(remoteSessionStorage.loadLiveDraft(), /captureState/)
  queue.push({ value: { ...checkpoint, nextChunkIndex: 3 } })
  await assert.rejects(remoteSessionStorage.loadImportCheckpoint(), /nextChunkIndex/)

  assert.deepEqual(calls, [
    '/api/data/sessions', '/api/data/live-draft', '/api/data/live-draft', '/api/data/live-draft', '/api/data/import-checkpoint', '/api/data/import-checkpoint',
    '/api/data/sessions', '/api/data/sessions', '/api/data/sessions', '/api/data/sessions', '/api/data/live-draft', '/api/data/import-checkpoint'
  ])
  console.log('PASS remote response validation: complete and legacy session payloads load; absent drafts/checkpoints stay undefined; malformed versions, segments, audio state, draft state, and checkpoint offsets reject before any fallback overwrite')
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { delete globalThis.__remoteResponseFetch })
