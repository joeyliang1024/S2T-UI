// Real renderer VAD, adapter, translation queue and RAF paint instrumentation.
// Only capture input is synthetic; all inference goes through the K8s Gateway.
import React, { useState, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { OpenAiChunkedModelAdapter } from '../../frontend/src/features/models/adapters/openai-chunked'
import { speedToVadConfig } from '../../frontend/src/features/capture/vad'
import { TranslationQueue } from '../../frontend/src/features/translation/services/queue'
import { upsertLiveCaption } from '../../frontend/src/features/transcript/domain/live-caption'
import { CaptionPaintMetric } from '../../frontend/src/features/captions/views/CaptionPaintMetric'
import { registerCaptionTiming, setCaptionMeasurementActive, parseServerTiming } from '../../frontend/src/shared/services/caption-metrics'
import { authFetch } from '../../frontend/src/shared/http/authenticated-client'
let entries = [], publish = () => {}, samples = 0
const errors = [], seconds = window.probeSeconds || 600
const read = async response => { const body = await response.json(); if (!response.ok) throw Error(`HTTP ${response.status}: ${body.error}`); return { text: body.text, server: parseServerTiming(response.headers.get('server-timing')) } }
const queue = new TranslationQueue(() => entries, update => { entries = update(entries); publish() }, message => errors.push(message))
const adapter = new OpenAiChunkedModelAdapter({ id: 'k8s-probe', endpoint: '/api/transcriptions', model: 'performance', vadConfig: speedToVadConfig('normal') }, {
  cancellation: 'request', ensureReady: async () => {}, hasSpeech: async () => true,
  transcribe: async request => ({ ...await read(await authFetch('/api/transcriptions', { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-s2t-language': 'en', 'x-s2t-idempotency-key': request.key }, body: request.audio, signal: request.signal })), detectedLanguage: 'en-US' })
})
adapter.onError(message => errors.push(message))
adapter.onTranscript(event => { registerCaptionTiming(event.id, event); entries = upsertLiveCaption(entries, event, -1, id => queue.isActive(id)); publish() })
const options = () => ({ targetLanguage: 'zh-TW', strategy: 'realtime', elapsedMs: samples / 16 })
const translate = async (entry, signal) => read(await authFetch('/api/translations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-s2t-idempotency-key': `probe-${entry.id}` }, body: JSON.stringify({ text: entry.sourceText, sourceLanguage: 'en-US', targetLanguage: 'zh-TW' }), signal }))
function View() {
  const [, render] = useState(0)
  useLayoutEffect(() => { setCaptionMeasurementActive(true); publish = () => render(n => n + 1); window.probeReady = true; return () => setCaptionMeasurementActive(false) }, [])
  return <div className="transcript">{entries.slice(-15).map(entry => <article key={entry.id}><CaptionPaintMetric members={[entry]} text={entry.sourceText}/>{entry.translatedText && <CaptionPaintMetric members={[entry]} text={entry.translatedText} translation/>}</article>)}</div>
}
createRoot(document.getElementById('root')).render(<View/> )
window.startProbe = async () => {
  const startedAt = new Date().toISOString(), startSkewMs = Date.now() - (window.probeExpectedStartAt || Date.now())
  await adapter.start({ sampleRate: 16000, language: 'en-US', targetLanguage: 'zh-TW' })
  const start = performance.now()
  const feed = setInterval(() => {
    const expected = Math.floor(Math.min(seconds * 1000, performance.now() - start) / 20) * 320
    while (samples < expected) {
      const silent = (samples / 16) % 2400 >= 2000
      const frame = Float32Array.from({ length: 320 }, (_, i) => silent ? 0 : .12 * Math.sin(2 * Math.PI * 180 * (samples + i) / 16000))
      adapter.pushAudio(frame, samples); samples += frame.length
    }
  }, 20)
  const tick = setInterval(() => queue.tick(options(), translate), 100)
  await new Promise(resolve => setTimeout(resolve, seconds * 1000 + 50)); clearInterval(feed)
  await adapter.stop(); await queue.drain(options(), translate); clearInterval(tick)
  await new Promise(resolve => setTimeout(resolve, 1000))
  window.probeResult = { seconds, startedAt, startSkewMs, synchronizationValid: Math.abs(startSkewMs) < 1000, captions: entries.length, translated: entries.filter(x => x.translatedText).length, errors, asr: adapter.diagnostics, translation: queue.diagnostics, note: 'One visible Chromium probe under concurrent K8s load; see synchronized controller for user count. Synthetic PCM uses real renderer energy VAD, ASR adapter, translation queue and double-RAF caption paint; excludes physical microphone, Silero model and WAN.' }
}
