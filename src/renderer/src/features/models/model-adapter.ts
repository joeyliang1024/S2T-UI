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
  translationStatus?: 'failed' | 'completed'
  /** Failed automatic translation attempts for this exact caption revision. */
  translationAttempts?: number
  /** Changes only when translation input or a manual translation changes. */
  translationContentRevision?: number
  /** True only when app-side VAD observed a natural silence boundary. HTTP
   * chunks sent while speech continues deliberately keep this false so the UI
   * can extend one readable caption instead of making a new row. */
  isSentenceBoundary?: boolean
  /** Updates only closure metadata; never replaces a manually edited caption. */
  boundaryOnly?: boolean
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
  /** Mark a pause boundary without ending the capture session. */
  flush?(): void
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
  private pendingBoundaries: number[] = []
  private explicitBoundaries = new Set<number>()
  private vadSpeaking = false
  private lastSpeechSample = 0
  private readonly maximumPendingSeconds = 30
  private prompt?: string
  /** Tail of the last successful caption; conditions the next short chunk. */
  private rollingContext = ''
  private lastTranscript?: TranscriptEvent
  private overflowGap?: TranscriptEvent & { emittedEndMs: number }
  private vadConfig?: VadConfig
  private activeGatewayRequests = new Set<AbortController>()
  private readonly gatewayTimeoutMs = 30_000
  readonly diagnostics = { requests: 0, completed: 0, rateLimited: 0, gaps: 0, inFlight: 0, maximumQueued: 0, totalRequestMs: 0, totalQueueWaitMs: 0, maximumPendingMs: 0 }

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
    this.pendingBoundaries = []
    this.explicitBoundaries.clear()
    this.vadSpeaking = false
    this.lastSpeechSample = 0
    this.rollingContext = ''
    this.lastTranscript = undefined
    this.overflowGap = undefined
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
    const configuredMaximumMs = Math.max(configuredMinimum, configuredMaximum, 200)
    this.vadSpeaking = Boolean(vadFrame?.speaking)
    if (this.vadSpeaking || vadFrame?.speechStarted) this.lastSpeechSample = startSample + chunk.length
    this.pendingContainsSpeech ||= Boolean(vadFrame?.speechStarted || this.vadSpeaking)
    if (this.pendingContainsSpeech && vadFrame?.speechEnded) this.pendingBoundaries.push(startSample + chunk.length)
    if (!this.pendingContainsSpeech && this.pendingSamples > this.sampleRate * configuredMaximumMs / 1000) {
      const preRoll = Math.floor(this.sampleRate * (this.vadConfig?.preRollMs ?? 300) / 1000)
      this.discardPending(this.pendingSamples - preRoll)
      return
    }
    // Keep a bounded audio backlog, rather than discard every chunk while a
    // healthy but slow request occupies the four ordered request slots.
    const maximumPending = this.sampleRate * this.maximumPendingSeconds
    if (this.pendingSamples > maximumPending) {
      const startMs = Math.round(this.pendingStart / this.sampleRate * 1000)
      this.discardPending(this.pendingSamples - maximumPending)
      this.recordOverflow(startMs, Math.round(this.pendingStart / this.sampleRate * 1000))
    }
    this.diagnostics.maximumPendingMs = Math.max(this.diagnostics.maximumPendingMs, this.pendingSamples / this.sampleRate * 1000)
    this.flushPending()
  }

  private flushPending(): void {
    const configuredMaximum = Math.max(this.vadConfig?.chunkMinMs ?? 1000, this.vadConfig?.chunkMaxMs ?? 2400, 200)
    while (this.pendingBoundaries.length && this.pendingBoundaries[0] <= this.pendingStart) this.pendingBoundaries.shift()
    this.pendingContainsSpeech = this.vadSpeaking || this.pendingStart < this.lastSpeechSample || this.pendingBoundaries.length > 0
    while (this.pendingSamples && this.pendingContainsSpeech && this.queuedChunks < this.maximumQueuedChunks) {
      const maximum = Math.floor(this.sampleRate * Math.min(6000, configuredMaximum * (this.queuedChunks >= 2 ? 2 : 1)) / 1000)
      const boundary = this.pendingBoundaries[0]
      const toBoundary = boundary === undefined ? Infinity : boundary - this.pendingStart
      if (this.pendingSamples < maximum && toBoundary > this.pendingSamples) break
      const size = Math.min(maximum, toBoundary, this.pendingSamples)
      const natural = size === toBoundary
      const start = this.pendingStart
      const audio = this.takePending(size)
      if (natural) this.pendingBoundaries.shift()
      this.flushOverflow()
      this.enqueue(audio, start, natural)
      this.pendingContainsSpeech = this.vadSpeaking || this.pendingStart < this.lastSpeechSample || this.pendingBoundaries.length > 0
    }
  }

  flush(): void {
    if (this.stopped) return
    const end = this.pendingStart + this.pendingSamples
    if (this.pendingContainsSpeech && (this.pendingSamples || this.queuedChunks)) {
      this.explicitBoundaries.add(end)
      if (this.pendingSamples && this.pendingBoundaries[this.pendingBoundaries.length - 1] !== end) this.pendingBoundaries.push(end)
    }
    // Pause has no incoming silence frames; reset onset detection for resume.
    this.vad = new EnergyVad(this.sampleRate, this.vadConfig)
    this.vadSpeaking = false
    this.flushPending()
    this.closePreviousCaption(Math.round(end / this.sampleRate * 1000))
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.flushOverflow()
    // Normal stop drains accepted audio. Aborting here used to turn the last
    // in-flight chunk into a gap even when the model was working normally.
    if (this.queuedChunks >= this.maximumQueuedChunks) await this.queued
    // A retained backlog can be longer than one provider request should carry.
    // Drain it in bounded clips, retaining natural endpoints and final closure.
    while (this.pendingSamples && this.pendingContainsSpeech) {
      if (this.queuedChunks >= this.maximumQueuedChunks) await this.queued
      const start = this.pendingStart
      while (this.pendingBoundaries.length && this.pendingBoundaries[0] <= start) this.pendingBoundaries.shift()
      const boundary = this.pendingBoundaries[0]
      const size = Math.min(this.pendingSamples, this.sampleRate * 6, boundary === undefined ? Infinity : boundary - start)
      const final = size === this.pendingSamples
      const natural = boundary === start + size
      if (natural) this.pendingBoundaries.shift()
      this.enqueue(this.takePending(size), start, natural || final)
      this.pendingContainsSpeech = this.pendingStart < this.lastSpeechSample || this.pendingBoundaries.length > 0
    }
    this.pendingChunks = []
    this.pendingSamples = 0
    this.pendingContainsSpeech = false
    this.pendingBoundaries = []
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
    const endSample = startSample + audio.length
    const endMs = Math.round(endSample / this.sampleRate * 1000)
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
      if (this.profile.sileroVadEnabled && !await this.hasSileroSpeech(wav)) {
        if (isSentenceBoundary || this.explicitBoundaries.has(endSample)) this.closePreviousCaption(startMs)
        return
      }
      const response = await this.transcribeWithRetry(wav)
      const sourceText = sanitizeAsrText(response.text)
      if (!sourceText) {
        if (isSentenceBoundary || this.explicitBoundaries.has(endSample)) this.closePreviousCaption(startMs)
        return
      }
      this.rollingContext = sourceText
      const event: TranscriptEvent = { id: `http-${sequence}`, revision: 1, status: 'final', startMs, endMs, sourceText, detectedLanguage: response.detectedLanguage, isSentenceBoundary: isSentenceBoundary || this.explicitBoundaries.has(endSample) }
      this.lastTranscript = event
      this.listeners.forEach((listener) => listener(event))
    }).catch((error: unknown) => {
      this.emitError(error instanceof Error ? error.message : activeTranslate('svcModelTranscribeFailed'))
      this.emitGap(sequence, startMs, endMs, 'request-failed')
    }).finally(() => {
      this.queuedChunks -= 1
      this.explicitBoundaries.delete(endSample)
      if (!this.stopped) this.flushPending()
    })
  }

  private recordOverflow(startMs: number, endMs: number): void {
    if (!this.overflowGap || this.overflowGap.endMs !== startMs) {
      this.flushOverflow()
      this.emitError(activeTranslate('svcModelTooSlow'))
      this.diagnostics.gaps += 1
      this.overflowGap = { id: `gap-${this.sequence++}`, revision: 1, status: 'gap', startMs, endMs, sourceText: '', gapReason: 'queue-overflow', emittedEndMs: endMs }
      const { emittedEndMs: _, ...event } = this.overflowGap
      this.listeners.forEach(listener => listener(event))
      return
    }
    this.overflowGap.endMs = endMs
    if (endMs - this.overflowGap.emittedEndMs >= 1000) this.emitOverflow()
  }

  private emitOverflow(): void {
    if (!this.overflowGap || this.overflowGap.endMs === this.overflowGap.emittedEndMs) return
    this.overflowGap.emittedEndMs = this.overflowGap.endMs
    this.overflowGap.revision += 1
    const { emittedEndMs: _, ...event } = this.overflowGap
    this.listeners.forEach(listener => listener(event))
  }

  private flushOverflow(): void {
    this.emitOverflow()
    this.overflowGap = undefined
  }

  private closePreviousCaption(startMs: number): void {
    const previous = this.lastTranscript
    if (!previous || previous.isSentenceBoundary || previous.endMs !== startMs) return
    this.lastTranscript = { ...previous, revision: previous.revision + 1, isSentenceBoundary: true }
    this.listeners.forEach(listener => listener({ ...this.lastTranscript!, boundaryOnly: true }))
  }

  private emitGap(sequence: number, startMs: number, endMs: number, gapReason: TranscriptEvent['gapReason']): void {
    this.diagnostics.gaps += 1
    const event: TranscriptEvent = { id: `gap-${sequence}`, revision: 1, status: 'gap', startMs, endMs, sourceText: '', gapReason }
    this.listeners.forEach((listener) => listener(event))
  }

  private async transcribeWithRetry(audio: ArrayBuffer): Promise<{ text: string; detectedLanguage?: TranscriptEvent['detectedLanguage'] }> {
    const request = { key: crypto.randomUUID(), language: this.language, prompt: this.rollingPrompt() }
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
            language: request.language, requiresApiKey: this.profile.requiresApiKey !== false, prompt: request.prompt, audio
          }) : await this.transcribeThroughWebGateway(audio, request)
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

  private async transcribeThroughWebGateway(audio: ArrayBuffer, request = { key: crypto.randomUUID(), language: this.language, prompt: this.rollingPrompt() }): Promise<{ text: string; detectedLanguage?: TranscriptEvent['detectedLanguage'] }> {
    const prompt = request.prompt
    const controller = new AbortController()
    this.activeGatewayRequests.add(controller)
    const timeout = window.setTimeout(() => controller.abort(), this.gatewayTimeoutMs)
    try {
      const response = await authFetch('/api/transcriptions', {
        method: 'POST',
        headers: {
          'content-type': 'audio/wav',
          'x-s2t-idempotency-key': request.key,
          'x-s2t-language': request.language,
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
