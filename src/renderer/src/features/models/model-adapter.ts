import { EnergyVad, type VadConfig } from '../capture/vad'
import { authFetch } from '../auth/services/auth-client'
import { HttpServiceError, readJsonResponse } from '../../shared/services/http'
import { activeTranslate } from '../../shared/i18n'

export type TranscriptEvent = {
  id: string
  revision: number
  asrRevision?: number
  /** Stable display row, locked before speaker identification. */
  captionGroupId?: string
  status: 'partial' | 'final' | 'gap'
  startMs: number
  endMs: number
  sourceText: string
  translatedText?: string
  speaker?: string
  /** User-provided speaker names are authoritative over later diarization passes. */
  speakerManuallyEdited?: boolean
  translationStatus?: 'failed'
  /** Failed automatic translation attempts for this exact caption revision. */
  translationAttempts?: number
  /** Changes only when translation input or a manual translation changes. */
  translationContentRevision?: number
  /** True only when app-side VAD observed a natural silence boundary. HTTP
   * chunks sent while speech continues deliberately keep this false so the UI
   * can extend one readable caption instead of making a new row. */
  isSentenceBoundary?: boolean
  /** Best-effort app-side source language when ASR runs in automatic mode. */
  detectedLanguage?: 'zh-TW' | 'en-US' | 'ja-JP' | 'de-DE'
  /** Present only when audio could not be transcribed. Export this event so a
   * reviewer can distinguish an ASR failure from a genuine silent interval. */
  gapReason?: 'queue-overflow' | 'request-failed'
}

export interface ModelAdapter {
  start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void>
  pushAudio(chunk: Float32Array, startSample: number): void
  stop(): Promise<void>
  onTranscript(listener: (event: TranscriptEvent) => void): () => void
  onError(listener: (message: string) => void): () => void
  /** Applies settings to audio received after this call; it never restarts capture. */
  updateLiveSettings?(input: { language?: string; prompt?: string; vadConfig?: VadConfig }): void
}

/**
 * Some OpenAI-compatible Whisper deployments leak decoder-internal tokens
 * (timestamp markers like `<|8.59|>`) or hallucinated `||` separators into
 * `text`. Strip them once at the adapter boundary so merged captions,
 * translation input and exports never see the artifacts.
 */
export const sanitizeAsrText = (text: string): string =>
  text.replace(/<\|[^|]*\|>/g, ' ').replace(/\|\|/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * A deliberately quiet placeholder. Replace this with the adapter for the
 * user-supplied model without changing the capture or subtitle UI contracts.
 */
export class NoopModelAdapter implements ModelAdapter {
  private listeners = new Set<(event: TranscriptEvent) => void>()
  private errorListeners = new Set<(message: string) => void>()

  async start(_input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {}
  pushAudio(_chunk: Float32Array, _startSample: number): void {}
  async stop(): Promise<void> {}
  onTranscript(listener: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }
}

type WireTranscript = {
  type: 'transcript'
  id: string
  revision: number
  status: 'partial' | 'final'
  startMs: number
  endMs: number
  sourceText: string
  translatedText?: string
  /** Optional ISO-like source language returned by the ASR service. */
  detectedLanguage?: string
}

/**
 * Generic WebSocket transport for the self-hosted STT service contract in
 * docs/reference/MODEL_ADAPTER.md. It deliberately keeps recognition logic server-side.
 */
export class WebSocketModelAdapter implements ModelAdapter {
  private socket: WebSocket | null = null
  private listeners = new Set<(event: TranscriptEvent) => void>()
  private sequence = 0
  private streamId = ''
  private stopping = false
  private lastBackpressureWarning = 0
  private errorListeners = new Set<(message: string) => void>()

  constructor(private readonly endpoint: string) {}

  async start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint)
      const timeout = window.setTimeout(() => {
        socket.close()
        reject(new Error(activeTranslate('svcModelConnectTimeout')))
      }, 10_000)
      socket.binaryType = 'arraybuffer'
      socket.onopen = () => {
        window.clearTimeout(timeout)
        this.socket = socket
        this.stopping = false
        this.sequence = 0
        this.streamId = crypto.randomUUID()
        socket.send(JSON.stringify({
          type: 'start', streamId: this.streamId, audioFormat: 'f32le', channels: 1,
          sampleRate: input.sampleRate, language: input.language, targetLanguage: input.targetLanguage
        }))
        resolve()
      }
      socket.onerror = () => {
        window.clearTimeout(timeout)
        if (this.socket === socket) this.emitError(activeTranslate('svcModelSocketError'))
        reject(new Error(activeTranslate('svcModelConnectFailed')))
      }
      socket.onmessage = (message) => this.handleMessage(message.data)
      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = null
        if (!this.stopping) this.emitError(activeTranslate('svcModelSocketClosed'))
      }
    })
  }

  pushAudio(chunk: Float32Array, startSample: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (this.socket.bufferedAmount > 2 * 1024 * 1024) {
      if (Date.now() - this.lastBackpressureWarning > 5_000) {
        this.lastBackpressureWarning = Date.now()
        this.emitError(activeTranslate('svcModelTooSlow'))
      }
      return
    }
    this.socket.send(JSON.stringify({
      type: 'audio', streamId: this.streamId, sequence: this.sequence++,
      startSample, frameCount: chunk.length
    }))
    const bytes = chunk.slice().buffer
    this.socket.send(bytes)
  }

  async stop(): Promise<void> {
    const socket = this.socket
    if (!socket) return
    this.stopping = true
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }))
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, 2_000)
      socket.addEventListener('close', () => {
        window.clearTimeout(timeout)
        resolve()
      }, { once: true })
      window.setTimeout(() => socket.close(), 1_500)
    })
    this.socket = null
  }

  onTranscript(listener: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  private emitError(message: string): void {
    this.errorListeners.forEach((listener) => listener(message))
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return
    try {
      const event = JSON.parse(data) as Partial<WireTranscript>
      if (event.type !== 'transcript' || !event.id || typeof event.revision !== 'number' ||
        (event.status !== 'partial' && event.status !== 'final') || typeof event.startMs !== 'number' ||
        typeof event.endMs !== 'number' || typeof event.sourceText !== 'string') return
      const transcript: TranscriptEvent = {
        id: event.id, revision: event.revision, status: event.status,
        startMs: event.startMs, endMs: event.endMs, sourceText: sanitizeAsrText(event.sourceText),
        translatedText: typeof event.translatedText === 'string' ? event.translatedText : undefined,
        detectedLanguage: event.detectedLanguage === 'zh-TW' || event.detectedLanguage === 'en-US' || event.detectedLanguage === 'ja-JP' || event.detectedLanguage === 'de-DE'
          ? event.detectedLanguage
          : undefined
      }
      this.listeners.forEach((listener) => listener(transcript))
    } catch {
      // Ignore malformed server frames while retaining the recording.
    }
  }
}

const wavFromFloat32 = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, index) => {
    const normalized = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + index * 2, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
  })
  return buffer
}

const readGatewayPayload = async (response: Response): Promise<{ text?: string; error?: string; detectedLanguage?: string }> => {
  const body = await response.text()
  if (!body.trim()) throw new Error(activeTranslate('svcHttpNoBody').replace('{service}', 'Web ASR gateway').replace('{status}', String(response.status)))
  try { return JSON.parse(body) as { text?: string; error?: string } } catch { throw new Error(activeTranslate('svcHttpNonJson').replace('{service}', 'Web ASR gateway').replace('{status}', String(response.status))) }
}

/**
 * OpenAI-compatible `/v1/audio/transcriptions` endpoints are request/response,
 * so the adapter sends consecutive short WAV chunks and emits each answer as it
 * arrives. The key never enters this adapter; Electron main owns it.
 */
export class OpenAiChunkedModelAdapter implements ModelAdapter {
  private listeners = new Set<(event: TranscriptEvent) => void>()
  private errorListeners = new Set<(message: string) => void>()
  private sampleRate = 48_000
  private language = 'zh'
  private pendingChunks: Float32Array[] = []
  private pendingSamples = 0
  private pendingStart = 0
  private queued = Promise.resolve()
  private sequence = 0
  private stopped = false
  private queuedChunks = 0
  private readonly maximumQueuedChunks = 4
  private vad: EnergyVad | null = null
  private pendingContainsSpeech = false
  private prompt?: string
  /** Tail of the last successful caption; conditions the next short chunk. */
  private rollingContext = ''
  private vadConfig?: VadConfig
  private activeGatewayRequests = new Set<AbortController>()
  private readonly gatewayTimeoutMs = 30_000
  readonly diagnostics = { requests: 0, completed: 0, rateLimited: 0, gaps: 0, inFlight: 0, maximumQueued: 0, totalRequestMs: 0, totalQueueWaitMs: 0 }

  constructor(private readonly profile: { id: string; endpoint: string; model: string; requiresApiKey?: boolean; gatewayProfileId?: string; prompt?: string; vadConfig?: VadConfig; sileroVadEnabled?: boolean; dynaudnormEnabled?: boolean }) {
    this.prompt = profile.prompt
    this.vadConfig = profile.vadConfig
  }

  async start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {
    if (!this.profile.endpoint.trim() || !this.profile.model.trim()) throw new Error(activeTranslate('svcAsrEndpointRequired'))
    if (window.s2t && this.profile.requiresApiKey !== false && !(await window.s2t.hasModelApiKey(this.profile.id))) throw new Error(activeTranslate('svcModelApiKeyRequired'))
    if (!window.s2t && !this.profile.gatewayProfileId) throw new Error(activeTranslate('svcWebAsrModelOnly'))
    this.sampleRate = input.sampleRate
    // An empty value deliberately omits OpenAI's optional `language` field and
    // lets the ASR model identify Chinese, English, Japanese, or German.
    this.language = input.language === 'auto' ? '' : input.language.split('-')[0]
    this.pendingChunks = []
    this.pendingSamples = 0
    this.pendingStart = 0
    this.queued = Promise.resolve()
    this.sequence = 0
    this.stopped = false
    this.queuedChunks = 0
    this.vad = new EnergyVad(this.sampleRate, this.vadConfig)
    this.pendingContainsSpeech = false
    this.rollingContext = ''
    this.activeGatewayRequests.clear()
    Object.keys(this.diagnostics).forEach((key) => { this.diagnostics[key as keyof typeof this.diagnostics] = 0 })
  }

  pushAudio(chunk: Float32Array, startSample: number): void {
    if (this.stopped) return
    const vadFrame = this.vad?.process(chunk)
    if (this.pendingSamples === 0) this.pendingStart = startSample
    this.pendingChunks.push(chunk)
    this.pendingSamples += chunk.length
    // Request/response Whisper-like models are less stable on sub-second clips.
    // Keep ASR latency bounded while preferring natural VAD sentence boundaries.
    const configuredMinimum = this.vadConfig?.chunkMinMs ?? 1_000
    const configuredMaximum = this.vadConfig?.chunkMaxMs ?? 2_400
    const minimumChunkSamples = Math.floor(this.sampleRate * Math.min(configuredMinimum, configuredMaximum) / 1000)
    const configuredMaximumMs = Math.max(configuredMinimum, configuredMaximum, 200)
    // HTTP ASR is ordered so rolling context stays correct. If the provider is
    // marginally slower than real time, fixed 2–3s chunks accumulate one
    // request at a time until captions are visibly behind. Coalesce only while
    // backlogged (up to 6s) to recover throughput without sacrificing normal
    // low-latency behavior.
    const adaptiveMaximumMs = Math.min(6_000, configuredMaximumMs * (this.queuedChunks >= 2 ? 2 : 1))
    const maximumChunkSamples = Math.floor(this.sampleRate * adaptiveMaximumMs / 1000)
    this.pendingContainsSpeech ||= Boolean(vadFrame?.speechStarted || vadFrame?.speaking)
    const reachedNaturalBoundary = this.pendingSamples >= minimumChunkSamples && Boolean(vadFrame?.speechEnded)
    // Keep 300 ms of room tone before a voice onset, but avoid sending empty
    // requests while nobody is speaking.
    if (!this.pendingContainsSpeech && this.pendingSamples > maximumChunkSamples) {
      const preRollSamples = Math.floor(this.sampleRate * (this.vadConfig?.preRollMs ?? 300) / 1000)
      this.discardPending(this.pendingSamples - preRollSamples)
      return
    }
    while (this.pendingSamples >= maximumChunkSamples || reachedNaturalBoundary) {
      const size = reachedNaturalBoundary ? this.pendingSamples : maximumChunkSamples
      const start = this.pendingStart
      const audio = this.takePending(size)
      this.enqueue(audio, start, reachedNaturalBoundary)
      this.pendingContainsSpeech = Boolean(vadFrame?.speaking)
      if (this.pendingSamples < minimumChunkSamples) break
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Normal stop drains accepted audio. Aborting here used to turn the last
    // in-flight chunk into a gap even when the model was working normally.
    if (this.queuedChunks >= this.maximumQueuedChunks) await this.queued
    if (this.pendingSamples && this.pendingContainsSpeech) {
      const start = this.pendingStart
      this.enqueue(this.takePending(this.pendingSamples), start, true)
    }
    this.pendingChunks = []
    this.pendingSamples = 0
    this.pendingContainsSpeech = false
    await this.queued
  }

  onTranscript(listener: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  onError(listener: (message: string) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }
  updateLiveSettings(input: { language?: string; prompt?: string; vadConfig?: VadConfig }): void {
    if (input.language !== undefined) this.language = input.language === 'auto' ? '' : input.language.split('-')[0]
    if (input.prompt !== undefined) this.prompt = input.prompt || undefined
    if (input.vadConfig) {
      this.vadConfig = input.vadConfig
      this.vad = new EnergyVad(this.sampleRate, this.vadConfig)
    }
  }

  private enqueue(audio: Float32Array, startSample: number, isSentenceBoundary = false): void {
    const sequence = this.sequence++
    const startMs = Math.round(startSample / this.sampleRate * 1000)
    const endMs = Math.round((startSample + audio.length) / this.sampleRate * 1000)
    if (this.queuedChunks >= this.maximumQueuedChunks) {
      this.emitError(activeTranslate('svcModelTooSlow'))
      this.emitGap(sequence, startMs, endMs, 'queue-overflow')
      return
    }
    this.queuedChunks += 1
    this.diagnostics.maximumQueued = Math.max(this.diagnostics.maximumQueued, this.queuedChunks)
    const enqueuedAt = Date.now()
    this.queued = this.queued.catch(() => undefined).then(async () => {
      this.diagnostics.totalQueueWaitMs += Date.now() - enqueuedAt
      const wav = wavFromFloat32(audio, this.sampleRate)
      if (this.profile.sileroVadEnabled && !await this.hasSileroSpeech(wav)) return
      const response = await this.transcribeWithRetry(wav)
      const sourceText = sanitizeAsrText(response.text)
      if (!sourceText) return
      this.rollingContext = sourceText
      const event: TranscriptEvent = { id: `http-${sequence}`, revision: 1, status: 'final', startMs, endMs, sourceText, detectedLanguage: response.detectedLanguage, isSentenceBoundary }
      this.listeners.forEach((listener) => listener(event))
    }).catch((error: unknown) => {
      this.emitError(error instanceof Error ? error.message : activeTranslate('svcModelTranscribeFailed'))
      this.emitGap(sequence, startMs, endMs, 'request-failed')
    }).finally(() => { this.queuedChunks -= 1 })
  }

  private emitGap(sequence: number, startMs: number, endMs: number, gapReason: TranscriptEvent['gapReason']): void {
    this.diagnostics.gaps += 1
    const event: TranscriptEvent = { id: `gap-${sequence}`, revision: 1, status: 'gap', startMs, endMs, sourceText: '', gapReason }
    this.listeners.forEach((listener) => listener(event))
  }

  private async transcribeWithRetry(audio: ArrayBuffer): Promise<{ text: string; detectedLanguage?: TranscriptEvent['detectedLanguage'] }> {
    const delays = [0, 250, 750, 1750]
    let lastError: unknown
    for (const delay of delays) {
      if (delay) await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
      try {
        const startedAt = Date.now()
        this.diagnostics.requests += 1
        this.diagnostics.inFlight += 1
        try {
          const result = window.s2t ? await window.s2t.transcribeAudioChunk({
            profileId: this.profile.id, endpoint: this.profile.endpoint, model: this.profile.model,
            language: this.language, requiresApiKey: this.profile.requiresApiKey !== false, prompt: this.rollingPrompt(), audio
          }) : await this.transcribeThroughWebGateway(audio)
          this.diagnostics.completed += 1
          return result
        } finally { this.diagnostics.inFlight -= 1; this.diagnostics.totalRequestMs += Date.now() - startedAt }
      } catch (error) {
        // A hung gateway must release the live-caption queue immediately;
        // retrying the same timed-out request would leave the screen stalled.
        if (error instanceof Error && error.name === 'TimeoutError') throw error
        if (error instanceof HttpServiceError && error.status === 429) {
          this.diagnostics.rateLimited += 1
          // Do not rapidly spend retries inside the same rate-limit window.
          if (delay !== delays[delays.length - 1]) await new Promise<void>((resolve) => window.setTimeout(resolve, (error.retryAfterSeconds ?? 30) * 1000))
        }
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(activeTranslate('svcModelTranscribeFailed'))
  }

  /**
   * Request/response ASR loses cross-chunk context on sub-2s clips. Whisper's
   * own long-form decoding conditions on the previous text, so echoing the tail
   * of the last caption through the API `prompt` recovers boundary accuracy at
   * zero latency cost (measured: conversational CER 39.1% → 38.6%, empty
   * chunks 7 → 4). The rolling half is withheld in automatic language mode so
   * it cannot bias detection.
   */
  private rollingPrompt(): string | undefined {
    const combined = [this.prompt, this.language ? this.rollingContext.slice(-60) : '']
      .filter((value) => value && value.trim()).join('\n')
    return combined.trim() || undefined
  }

  private async hasSileroSpeech(audio: ArrayBuffer): Promise<boolean> {
    if (window.s2t) throw new Error(activeTranslate('svcSileroProvidedByGateway'))
    const response = await authFetch('/api/audio-processing/silero-vad', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio })
    const payload = await readGatewayPayload(response) as { error?: string; speech?: unknown[] }
    if (!response.ok) throw new Error(payload.error || activeTranslate('svcSileroGatewayFailed').replace('{status}', String(response.status)))
    return Array.isArray(payload.speech) && payload.speech.length > 0
  }

  private emitError(message: string): void {
    this.errorListeners.forEach((listener) => listener(message))
  }

  private takePending(sampleCount: number): Float32Array {
    const result = new Float32Array(sampleCount)
    let written = 0
    while (written < sampleCount && this.pendingChunks.length) {
      const chunk = this.pendingChunks[0]
      const take = Math.min(chunk.length, sampleCount - written)
      result.set(chunk.subarray(0, take), written)
      written += take
      if (take === chunk.length) this.pendingChunks.shift()
      else this.pendingChunks[0] = chunk.subarray(take)
    }
    this.pendingSamples -= written
    this.pendingStart += written
    return result
  }

  private discardPending(sampleCount: number): void {
    let remaining = sampleCount
    while (remaining > 0 && this.pendingChunks.length) {
      const chunk = this.pendingChunks[0]
      if (remaining >= chunk.length) {
        remaining -= chunk.length
        this.pendingChunks.shift()
      } else {
        this.pendingChunks[0] = chunk.subarray(remaining)
        remaining = 0
      }
    }
    const discarded = sampleCount - remaining
    this.pendingSamples -= discarded
    this.pendingStart += discarded
  }

  private async transcribeThroughWebGateway(audio: ArrayBuffer): Promise<{ text: string; detectedLanguage?: TranscriptEvent['detectedLanguage'] }> {
    const prompt = this.rollingPrompt()
    const controller = new AbortController()
    this.activeGatewayRequests.add(controller)
    const timeout = window.setTimeout(() => controller.abort(), this.gatewayTimeoutMs)
    try {
      const response = await authFetch('/api/transcriptions', {
        method: 'POST',
        headers: {
          'content-type': 'audio/wav',
          'x-s2t-idempotency-key': crypto.randomUUID(),
          'x-s2t-language': this.language,
          ...(this.profile.gatewayProfileId ? { 'x-s2t-model-id': this.profile.gatewayProfileId } : {}),
          ...(this.profile.dynaudnormEnabled ? { 'x-s2t-dynaudnorm': 'true' } : {}),
          ...(prompt ? { 'x-s2t-prompt': encodeURIComponent(prompt) } : {})
        },
        body: audio,
        signal: controller.signal
      })
      const payload = await readJsonResponse<{ text?: string; detectedLanguage?: string }>(response, 'Web ASR gateway')
      const detectedLanguage = payload.detectedLanguage === 'zh-TW' || payload.detectedLanguage === 'en-US' || payload.detectedLanguage === 'ja-JP' || payload.detectedLanguage === 'de-DE' ? payload.detectedLanguage : undefined
      return { text: payload.text || '', detectedLanguage }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const timeoutError = new Error(activeTranslate('svcAsrRequestTimeout'))
        timeoutError.name = 'TimeoutError'
        throw timeoutError
      }
      throw error
    } finally {
      window.clearTimeout(timeout)
      this.activeGatewayRequests.delete(controller)
    }
  }
}
