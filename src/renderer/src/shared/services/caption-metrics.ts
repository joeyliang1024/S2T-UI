import { CaptionMetricTransport, type CaptionMetricSample } from './caption-metric-transport'
import { authFetch } from '../../features/auth/services/auth-client'
export type CaptionTiming = { speechAt?: number; detectedAt?: number; chunkSpeechAt?: number; chunkDetectedAt?: number; queuedAt: number; dequeuedAt: number; requestAt: number; responseAt: number }
const timings = new WeakMap<object, CaptionTiming>()
const pending = new Map<string, CaptionTiming>()
const translationOrigins = new Map<string, CaptionTiming>()
const translations = new Map<string, { started: number; response: number }>()
// Only paints of newly received captions in the live view form a latency sample.
// Navigation/hidden tabs must never replay an old response as a fresh paint.
let liveViewActive = false
export const setCaptionMeasurementActive = (active: boolean): void => {
  liveViewActive = active
  if (!active) { pending.clear(); translationOrigins.clear(); translations.clear() }
}
const canMeasurePaint = (): boolean => liveViewActive && document.visibilityState === 'visible'
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { pending.clear(); translationOrigins.clear(); translations.clear() }
})
export const discardCaptionPaint = (ids: string[], translation = false): void => {
  for (const id of ids) {
    if (translation) { translations.delete(id); translationOrigins.delete(id) }
    else pending.delete(id)
  }
}
export const registerTranslationTiming = (id: string, started: number, response: number): void => {
  if (!canMeasurePaint()) return
  translations.set(id, { started, response })
  if (translations.size > 1000) translations.delete(translations.keys().next().value!)
}
export const reportTranslationPaint = (ids: string[], paintedAt: number): void => {
  if (!canMeasurePaint()) return
  const samples: Sample[] = []
  for (const id of ids) {
    const timing = translations.get(id), origin = translationOrigins.get(id)
    if (!timing) continue
    translations.delete(id); translationOrigins.delete(id)
    samples.push({ stage: 'translation_roundtrip', seconds: (timing.response - timing.started) / 1000 }, { stage: 'translation_response_to_paint', seconds: (paintedAt - timing.response) / 1000 })
    if (origin) {
      samples.push({ stage: 'translation_schedule_wait', seconds: (timing.started - origin.responseAt) / 1000 })
      if (origin.speechAt !== undefined) samples.push({ stage: 'speech_to_translation_paint', seconds: (paintedAt - origin.speechAt) / 1000 })
    }
  }
  if (samples.length) enqueue(samples.filter(sample => Number.isFinite(sample.seconds) && sample.seconds >= 0 && sample.seconds <= 300))
}
type Sample = CaptionMetricSample
const transport = new CaptionMetricTransport(async payload => {
  const response = await authFetch('/api/telemetry/captions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) })
  return response.ok
})
const enqueue = (samples: Sample[] = [], event?: 'speech_detected' | 'asr_empty' | 'asr_failed' | 'audio_gap'): void => {
  if (!window.s2t) transport.enqueue(samples, event)
}
export const recordCaptionEvent = (event: 'speech_detected' | 'asr_empty' | 'asr_failed' | 'audio_gap'): void => enqueue([], event)
export const attachCaptionTiming = (event: object, timing: CaptionTiming): void => { timings.set(event, timing) }
export const registerCaptionTiming = (id: string, event: object): void => {
  const timing = timings.get(event)
  if (!timing) return
  // Arrival-side timings end at receipt, independent of navigation and RAF.
  enqueue([
    { stage: 'browser_queue', seconds: (timing.dequeuedAt - timing.queuedAt) / 1000 },
    { stage: 'browser_preprocess', seconds: (timing.requestAt - timing.dequeuedAt) / 1000 },
    { stage: 'asr_roundtrip_with_retries', seconds: (timing.responseAt - timing.requestAt) / 1000 }
  ].filter(sample => Number.isFinite(sample.seconds) && sample.seconds >= 0 && sample.seconds <= 300))
  if (!canMeasurePaint()) return
  pending.set(id, timing)
  translationOrigins.set(id, timing)
  if (translationOrigins.size > 1000) translationOrigins.delete(translationOrigins.keys().next().value!)
  if (pending.size > 1000) pending.delete(pending.keys().next().value!)
}
// All six slices must come from the same first-word observation. Other
// chunks and overlapping server timings must not change the denominator.
export const buildFirstWordBreakdown = (timing: CaptionTiming, paintedAt: number): Sample[] => {
  const points = [timing.speechAt, timing.detectedAt, timing.queuedAt, timing.dequeuedAt, timing.requestAt, timing.responseAt, paintedAt]
  if (points.some(point => point === undefined || !Number.isFinite(point))) return []
  const times = points as number[]
  if (times.some((time, index) => index > 0 && time < times[index - 1]) || times[6] - times[0] > 300_000) return []
  const stages = ['vad_onset', 'chunk_wait', 'browser_queue', 'browser_preprocess', 'asr_roundtrip_with_retries', 'response_to_paint']
  return stages.map((stage, index) => ({ stage: `first_word_${stage}`, seconds: (times[index + 1] - times[index]) / 1000 }))
}
// Measurements are ephemeral: no transcript, user ID, model name or trace ID
// is sent or used as a Prometheus label. Missing/hidden paints are not zeroes.
export const reportCaptionPaint = (ids: string[], paintedAt: number): void => {
  if (!canMeasurePaint()) return
  const samples: Array<{ stage: string; seconds: number }> = []
  for (const id of ids) {
    const timing = pending.get(id)
    if (!timing) continue
    pending.delete(id)
    const add = (stage: string, start: number, end: number): void => {
      const seconds = (end - start) / 1000
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 300) samples.push({ stage, seconds })
    }
    if (timing.speechAt !== undefined && timing.detectedAt !== undefined) {
      add('speech_to_first_paint', timing.speechAt, paintedAt)
      add('vad_onset', timing.speechAt, timing.detectedAt)
      add('chunk_wait', timing.detectedAt, timing.queuedAt)
    }
    samples.push(...buildFirstWordBreakdown(timing, paintedAt))
    const chunkSlices = buildFirstWordBreakdown({ ...timing, speechAt: timing.chunkSpeechAt, detectedAt: timing.chunkDetectedAt }, paintedAt)
    if (chunkSlices.length) {
      add('chunk_speech_to_paint', timing.chunkSpeechAt!, paintedAt)
      samples.push(...chunkSlices.map(sample => ({ ...sample, stage: sample.stage.replace('first_word_', 'chunk_') })))
    }
    add('response_to_paint', timing.responseAt, paintedAt)
  }
  if (!samples.length || window.s2t) return // This deployment instruments the Web capture path.
  enqueue(samples)
}
