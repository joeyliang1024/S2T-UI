import React, { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { OpenAiChunkedModelAdapter } from '../../src/renderer/src/features/models/model-adapter'
import { speedToVadConfig } from '../../src/renderer/src/features/capture/vad'
import { TranslationQueue } from '../../src/renderer/src/features/app/services/translation-queue'
import { upsertLiveCaption, renderedLiveCaptionWindow } from '../../src/renderer/src/features/app/services/live-caption'
import { readJsonResponse } from '../../src/renderer/src/shared/services/http'
import { BufferedPcmWriter, pcm16 } from '../../src/renderer/src/shared/services/audio'
import { OpfsPcmRecording } from '../../src/renderer/src/shared/services/opfs-pcm-recording'

const durationMs = window.localTestDurationMs
const originalFetch = window.fetch.bind(window)
window.fetch = (url, options) => {
  const target = new URL(url, location.href)
  if (target.origin !== location.origin || !['/api/transcriptions', '/api/translations', '/progress', '/result'].includes(target.pathname)) throw new Error('Test forbids external requests')
  return originalFetch(target, options)
}
let entries = [], publish = () => {}, recording, fatal = null
const start = performance.now(), asrLag = [], translationLag = [], resources = []
const completedAt = new Map()
const queue = new TranslationQueue(() => entries, update => {
  entries = update(entries)
  for (const entry of entries) if (entry.translatedText && !completedAt.has(entry.id)) {
    completedAt.set(entry.id, performance.now())
    translationLag.push({ at: entry.endMs, lag: performance.now() - start - entry.endMs })
  }
  publish()
}, message => { document.getElementById('status').textContent = message })
const options = () => ({ targetLanguage: 'en', strategy: 'realtime', elapsedMs: sampleOffset / 16 })
const translate = async (entry, signal) => (await readJsonResponse(await fetch('/api/translations', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: entry.sourceText }), signal
}), 'Local mock translation')).text
const adapter = new OpenAiChunkedModelAdapter({ id: 'local-test', endpoint: '/api/transcriptions', model: 'local-mock', gatewayProfileId: 'default', vadConfig: speedToVadConfig('normal') })
adapter.onError(message => { fatal = message })
adapter.onTranscript(event => {
  if (event.status === 'final') asrLag.push({ at: event.endMs, lag: performance.now() - start - event.endMs })
  entries = upsertLiveCaption(entries, event, -1, id => queue.isActive(id))
  publish()
})
let sampleOffset = 0, writer
function View() {
  const [, render] = useState(0)
  useEffect(() => { publish = () => render(n => n + 1); return () => { publish = () => {} } }, [])
  const visible = renderedLiveCaptionWindow(entries.filter(e => e.status !== 'gap'))
  return <div>{visible.map(e => <article key={e.id} data-caption>{e.sourceText}<br/>{e.translatedText || '等待翻譯'}</article>)}</div>
}
createRoot(document.getElementById('captions')).render(<View />)
const percentile = list => { if (!list.length) return null; const values = list.map(x => x.lag).sort((a,b) => a-b); return values[Math.ceil(values.length*.95)-1] }
const resource = () => ({ seconds: Math.round((performance.now()-start)/1000), captions: entries.length, dom: document.querySelectorAll('[data-caption]').length, heapBytes: performance.memory?.usedJSHeapSize ?? null, inFlight: queue.inFlight, retries: queue.retryCount, asrQueued: adapter.queuedChunks, pendingAudioBytes: writer?.pendingBytes ?? null, bufferedAsrSamples: adapter.pendingSamples })
async function main() {
  recording = await OpfsPcmRecording.create(`local-test-${crypto.randomUUID()}`, 16000)
  if (!recording) throw new Error('Browser does not support OPFS; disk-backed capture cannot be verified')
  writer = new BufferedPcmWriter(audio => recording.append(audio), active => { if (active) fatal = 'PCM writer backpressure' }, error => { fatal = error.message })
  await adapter.start({ sampleRate: 16000, language: 'zh-TW', targetLanguage: 'en' })
  const started = performance.now()
  const timer = setInterval(() => {
    // Feed according to elapsed audio time, not the number of timer callbacks.
    // Small catch-up batches preserve the sample timeline through timer jitter.
    const expected = Math.floor(Math.min(durationMs, performance.now() - started) / 20) * 320
    while (sampleOffset < expected) {
      const ms = sampleOffset / 16
      const phase = ms % 12000
      const silent = phase > 9000 && phase % 1100 > 800
      const frame = Float32Array.from({ length: 320 }, (_, i) => silent ? 0 : .05 * Math.sin(2 * Math.PI * 180 * (sampleOffset+i) / 16000))
      writer.push(pcm16(frame)); adapter.pushAudio(frame, sampleOffset); sampleOffset += frame.length
    }
  }, 20)
  const translationTimer = setInterval(() => queue.tick(options(), translate), 220)
  const monitor = setInterval(() => {
    const snapshot = resource(); resources.push(snapshot)
    document.getElementById('progress').textContent = `${snapshot.seconds} 秒 / ${durationMs/1000} 秒，${snapshot.captions} 段字幕`
    void fetch('/progress', { method: 'POST', body: JSON.stringify(snapshot) })
  }, 30000)
  await new Promise(resolve => setTimeout(resolve, durationMs + 25))
  clearInterval(timer); clearInterval(translationTimer); clearInterval(monitor)
  queue.paused = true
  await adapter.stop()
  const drained = await queue.drain(options(), translate)
  await writer.closeAndDrain()
  const wav = await recording.finish()
  const expectedBytes = 44 + sampleOffset * 2
  const wavHeader = new DataView(await wav.slice(0,44).arrayBuffer())
  const snapshot = JSON.stringify(entries)
  const root = await navigator.storage.getDirectory()
  const name = `local-caption-snapshot-${crypto.randomUUID()}.json`
  const saved = await root.getFileHandle(name, { create: true })
  const writable = await saved.createWritable(); await writable.write(snapshot); await writable.close()
  const savedMatches = await (await saved.getFile()).text() === snapshot
  await root.removeEntry(name)
  await recording.discard()
  resources.push(resource())
  const final = entries.filter(e => e.status === 'final')
  const early = list => list.filter(x => x.at >= 0 && x.at < 120000)
  const late = list => list.filter(x => x.at >= durationMs-120000 && x.at < durationMs)
  const stats = { durationMs, elapsedMs: performance.now()-started, apiCallsExternal: 0, captions: final.length,
    translated: final.filter(e => e.translatedText).length, gaps: entries.filter(e => e.status === 'gap').length,
    failed: final.filter(e => e.translationStatus).length, drained, savedMatches, audioBytes: wav.size, expectedAudioBytes: expectedBytes,
    wavDataBytes: wavHeader.getUint32(40,true), asr: adapter.diagnostics, translation: queue.diagnostics,
    asrEarlyP95: percentile(early(asrLag)), asrLateP95: percentile(late(asrLag)), translationEarlyP95: percentile(early(translationLag)), translationLateP95: percentile(late(translationLag)), resources, fatal }
  stats.passed = !fatal && drained && savedMatches && stats.gaps === 0 && stats.failed === 0 && stats.captions === stats.translated &&
    stats.audioBytes === expectedBytes && stats.wavDataBytes === expectedBytes-44 && queue.inFlight === 0 && queue.retryCount === 0 &&
    resources.every(x => x.dom <= 500 && x.pendingAudioBytes < 192000 && x.asrQueued <= 4) &&
    stats.asrLateP95-stats.asrEarlyP95 <= 500 && stats.translationLateP95-stats.translationEarlyP95 <= 500
  document.getElementById('status').textContent = stats.passed ? '測試通過' : '測試失敗，請查看報告'
  await fetch('/result', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(stats) })
}
main().catch(async error => {
  document.getElementById('status').textContent = error.message
  await recording?.discard().catch(() => {})
  await fetch('/result', { method: 'POST', body: JSON.stringify({ passed: false, error: error.message }) })
})
