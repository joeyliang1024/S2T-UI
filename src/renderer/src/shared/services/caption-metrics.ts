import { CaptionMetricTransport, type CaptionMetricSample, type CaptionMetricEvent } from './caption-metric-transport'
import { authFetch } from '../http/authenticated-client'

/** Gateway Server-Timing values (milliseconds) for one model request. */
export type CaptionServerTiming = { upload?: number; queue?: number; pre?: number; model?: number; total: number }

export type CaptionTiming = {
  /** First onset of the utterance; retained for diagnostics. */
  speechAt?: number
  /** Last VAD speech sample in this chunk, using the audio sample clock. */
  speechEndAt?: number
  /** This chunk's first speech sample (sample clock), for visibility validation. */
  vadProcessingMs?: number
  chunkSpeechAt: number
  /** When the local VAD confirmed speech inside this chunk. */
  chunkDetectedAt: number
  queuedAt: number
  dequeuedAt: number
  /** Silero second-gate HTTP roundtrip; absent when the gate is disabled. */
  sileroProcessingMs?: number
  sileroStartAt?: number
  sileroEndAt?: number
  requestAt: number
  responseAt: number
  /** Set when text cleanup finished; t4_postprocess measures responseAt → here. */
  postEndAt?: number
  /** Server-Timing echoed by the gateway; absent on Electron or older gateways. */
  server?: CaptionServerTiming
}
const timings = new WeakMap<object, CaptionTiming>()
const pending = new Map<string, CaptionTiming>()
const translationOrigins = new Map<string, CaptionTiming>()
const translations = new Map<string, { started: number; response: number; server?: CaptionServerTiming }>()
// Only paints of newly received captions in the live view form a latency sample.
// Navigation/hidden tabs must never replay an old response as a fresh paint.
let liveViewActive = false
let visibleSince = Infinity
const clearPaints = (): void => { pending.clear(); translationOrigins.clear(); translations.clear() }
const resetMeasurementWindow = (): void => {
  clearPaints()
  visibleSince = liveViewActive && document.visibilityState === 'visible' ? performance.now() : Infinity
}
// A request crossing a navigation/visibility boundary is not a live latency sample.
const withinMeasurementWindow = (started: number): boolean => canMeasurePaint() && started >= visibleSince
export const setCaptionMeasurementActive = (active: boolean): void => {
  if (liveViewActive === active) return
  liveViewActive = active
  resetMeasurementWindow()
}
const canMeasurePaint = (): boolean => liveViewActive && document.visibilityState === 'visible'
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  resetMeasurementWindow()
})
export const discardCaptionPaint = (ids: string[], translation = false): void => {
  for (const id of ids) {
    if (translation) { translations.delete(id); translationOrigins.delete(id) }
    else pending.delete(id)
  }
}

/**
 * Parses a Server-Timing response header (`upload;dur=1.20, model;dur=820.00`).
 * Malformed entries are dropped; without a usable `total` there is no split.
 */
export const parseServerTiming = (header: string | null): CaptionServerTiming | undefined => {
  if (!header) return undefined
  const values: Record<string, number> = {}
  for (const entry of header.split(',')) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*;\s*dur\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(entry)
    if (match) values[match[1]] = Number(match[2])
  }
  if (values.total === undefined || !Number.isFinite(values.total)) return undefined
  const timing: CaptionServerTiming = { total: values.total }
  for (const key of ['upload', 'queue', 'pre', 'model'] as const) {
    if (values[key] !== undefined && Number.isFinite(values[key])) timing[key] = values[key]
  }
  return timing
}

type Sample = CaptionMetricSample
/** Samples are bounded [0, 300]s; an impossible split is dropped, never negative. */
const pushValue = (samples: Sample[], stage: string, seconds?: number): void => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0 || seconds > 300) return
  samples.push({ stage, seconds })
}
const pushSpan = (samples: Sample[], stage: string, start?: number, end?: number): void => {
  if (start === undefined || end === undefined) return
  pushValue(samples, stage, (end - start) / 1000)
}
/** Server-Timing carries milliseconds; samples are seconds. */
const pushMs = (samples: Sample[], stage: string, milliseconds?: number): void => {
  if (milliseconds === undefined) return
  pushValue(samples, stage, milliseconds / 1000)
}

export const registerTranslationTiming = (id: string, started: number, response: number, server?: CaptionServerTiming): void => {
  if (!withinMeasurementWindow(started)) return
  translations.set(id, { started, response, server })
  if (translations.size > 1000) translations.delete(translations.keys().next().value!)
}
export const reportTranslationPaint = (ids: string[], paintedAt: number): void => {
  if (!canMeasurePaint()) return
  const samples: Sample[] = []
  for (const id of ids) {
    const timing = translations.get(id), origin = translationOrigins.get(id)
    if (!timing) continue
    translations.delete(id); translationOrigins.delete(id)
    // t6：翻譯排隊與模型（模型時間目前已包含未來的不雅字過濾位置）。
    if (origin) pushSpan(samples, 't6_wait', origin.responseAt, timing.started)
    if (timing.server) {
      pushMs(samples, 't6_queue', timing.server.queue ?? 0)
      pushMs(samples, 't6_model', timing.server.model ?? 0)
      pushValue(samples, 't6_gateway', (timing.server.total - (timing.server.queue ?? 0) - (timing.server.model ?? 0)) / 1000)
      // 往返（ms）先扣掉伺服器耗時（ms）再轉秒，避免浮點與單位錯置。
      pushValue(samples, 't7_network', ((timing.response - timing.started) - timing.server.total) / 1000)
    } else {
      // 無 Server-Timing：整段往返無法拆分，全部歸入 t7_network。
      pushSpan(samples, 't7_network', timing.started, timing.response)
    }
    // t7：回傳譯文並渲染到 UI。
    pushSpan(samples, 't7_paint', timing.response, paintedAt)
    if (origin?.speechEndAt !== undefined && withinMeasurementWindow(origin.speechEndAt)) pushSpan(samples, 'e2e_translation_tail', origin.speechEndAt, paintedAt)
    if (origin?.speechEndAt !== undefined && withinMeasurementWindow(origin.speechEndAt)) pushSpan(samples, 'e2e_translation', origin.speechEndAt, paintedAt)
  }
  if (samples.length) enqueue(samples)
}
const transport = new CaptionMetricTransport(async payload => {
  const response = await authFetch('/api/telemetry/captions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) })
  return response.ok
})
const enqueue = (samples: Sample[] = [], event?: CaptionMetricEvent): void => {
  const phases = new Map<string, number>()
  for (const sample of samples) {
    if (/^t[1-467]_/.test(sample.stage)) {
      const phase = 'phase_' + sample.stage.slice(0, 2)
      phases.set(phase, (phases.get(phase) ?? 0) + sample.seconds)
    }
  }
  const totals = [...phases].map(([stage, seconds]) => ({ stage, seconds }))
  if (!window.s2t) transport.enqueue([...samples, ...totals], event)
}
export const recordCaptionEvent = (event: CaptionMetricEvent): void => enqueue([], event)
export const attachCaptionTiming = (event: object, timing: CaptionTiming): void => { timings.set(event, timing) }

/**
 * Arrival batch: every slice known once the transcription response is here —
 * t2 (VAD/分段), t1 (佇列/編碼/上傳), t3 (伺服器端 ASR), t4 (後處理) 與
 * t5_network (回傳網路與重試). Paint-dependent samples come at paint time.
 */
export const registerCaptionTiming = (id: string, event: object): void => {
  const timing = timings.get(event)
  if (!timing) return
  timings.delete(event)
  if (!withinMeasurementWindow(timing.chunkSpeechAt)) return
  const samples: Sample[] = []
  // t2：僅 VAD 邏輯執行與 Silero 二次確認；不包含講話或收集音訊時間。
  pushMs(samples, 't2_vad', timing.vadProcessingMs)
  pushMs(samples, 't2_gate', timing.sileroProcessingMs)
  // t1：瀏覽器佇列、WAV 編碼與伺服器收音訊（Server-Timing upload）。
  pushSpan(samples, 't1_queue', timing.queuedAt, timing.dequeuedAt)
  const gateMs = timing.sileroStartAt !== undefined && timing.sileroEndAt !== undefined ? timing.sileroEndAt - timing.sileroStartAt : 0
  pushSpan(samples, 't1_encode', timing.dequeuedAt + Math.max(0, gateMs), timing.requestAt)
  const server = timing.server
  if (server) {
    pushMs(samples, 't1_upload', server.upload)
    pushMs(samples, 't3_queue', server.queue)
    // 未啟用的前置處理不輸出 0 樣本，避免把「沒跑」誤當「很快」。
    if ((server.pre ?? 0) > 0) pushMs(samples, 't3_preprocess', server.pre)
    pushMs(samples, 't3_model', server.model)
    // 伺服器驗證／快取檢查／回應寫出等固定處理 = total − 已知分段。
    pushValue(samples, 't3_gateway', (server.total - (server.upload ?? 0) - (server.queue ?? 0) - (server.pre ?? 0) - (server.model ?? 0)) / 1000)
    // 往返（ms）先扣掉伺服器耗時（ms）再轉秒，避免浮點與單位錯置。
    pushValue(samples, 't5_network', ((timing.responseAt - timing.requestAt) - server.total) / 1000)
  } else {
    // 沒有 Server-Timing（舊版 gateway）：整段往返歸入 t5_network，仍不重疊。
    pushSpan(samples, 't5_network', timing.requestAt, timing.responseAt)
  }
  // t4：回應文字後處理（目前僅清理；標點／不雅字過濾加入後在此計時）。
  if (timing.postEndAt !== undefined) pushSpan(samples, 't4_postprocess', timing.responseAt, timing.postEndAt)
  if (samples.length) enqueue(samples)
  pending.set(id, timing)
  translationOrigins.set(id, timing)
  if (translationOrigins.size > 1000) translationOrigins.delete(translationOrigins.keys().next().value!)
  if (pending.size > 1000) pending.delete(pending.keys().next().value!)
}
// Measurements are ephemeral: no transcript, user ID, model name or trace ID
// is sent or used as a Prometheus label. Missing/hidden paints are not zeroes.
// t5_paint 與 e2e_asr 只在字幕真正繪出時計；導航或隱藏分頁不補報舊回應。
export const reportCaptionPaint = (ids: string[], paintedAt: number): void => {
  if (!canMeasurePaint()) return
  const samples: Sample[] = []
  for (const id of ids) {
    const timing = pending.get(id)
    if (!timing) continue
    pending.delete(id)
    pushSpan(samples, 't5_paint', timing.postEndAt ?? timing.responseAt, paintedAt)
    const networkMs = timing.responseAt - timing.requestAt - (timing.server?.total ?? 0)
    if (networkMs >= 0) pushValue(samples, 'phase_t5', (networkMs + paintedAt - (timing.postEndAt ?? timing.responseAt)) / 1000)
    pushSpan(samples, 'e2e_asr', timing.speechEndAt, paintedAt)
  }
  if (!samples.length || window.s2t) return // This deployment instruments the Web capture path.
  enqueue(samples)
}
