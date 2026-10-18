import type { ModelAdapter } from '../contracts'
import type { TranscriptEvent } from '../../../../../shared/contracts/transcript'
import { EventChannel } from '../../../shared/events/event-channel'
import { attachCaptionTiming, recordCaptionEvent, type CaptionServerTiming, type CaptionTiming } from '../../../shared/services/caption-metrics'
import { type BoundaryVad, defaultVadConfig, EnergyVad, type VadConfig } from '../../capture/vad'
import type { AsrTransport } from '../asr-transport'
import { HttpServiceError } from '../../../shared/services/http'
import { activeTranslate } from '../../../shared/i18n'
import { sanitizeAsrText, isRepetitiveAsrText } from '../domain/asr-text'
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

/**
 * OpenAI-compatible `/v1/audio/transcriptions` endpoints are request/response,
 * so the adapter sends consecutive short WAV chunks and emits each answer as it
 * arrives. The key never enters this adapter; Electron main owns it.
 */
export class OpenAiChunkedModelAdapter implements ModelAdapter {
  readonly capabilities = { pauseBoundary: true, liveSettings: true }
  private listeners = new EventChannel<TranscriptEvent>()
  private errorListeners = new EventChannel<string>()
  private sampleRate = 48_000
  private language = 'zh'
  private pendingChunks: Float32Array[] = []
  private pendingSamples = 0
  private speechOnsets: Array<{ sample: number; at: number; detected: number }> = []
  private audioClock = { sample: 0, at: 0 }
  private pendingStart = 0
  private queued = Promise.resolve()
  private sequence = 0
  private stopped = false
  private queuedChunks = 0
  private readonly maximumQueuedChunks = 4
  private vad: BoundaryVad | null = null
  private pendingContainsSpeech = false
  private pendingBoundaries: number[] = []
  private explicitBoundaries = new Set<number>()
  private vadSpeaking = false
  private lastSpeechSample = 0
  private lastVoicedSample = 0
  private readonly maximumPendingSeconds = 30
  private prompt?: string
  /** Tail of the last successful caption; conditions the next short chunk. */
  private rollingContext = ''
  private lastTranscript?: TranscriptEvent
  private overflowGap?: TranscriptEvent & { emittedEndMs: number }
  private vadConfig?: VadConfig
  readonly diagnostics = { requests: 0, completed: 0, rateLimited: 0, gaps: 0, inFlight: 0, maximumQueued: 0, totalRequestMs: 0, totalQueueWaitMs: 0, maximumPendingMs: 0 }

  constructor(private readonly profile: { id: string; endpoint: string; model: string; requiresApiKey?: boolean; gatewayProfileId?: string; prompt?: string; vadConfig?: VadConfig; strictChunkLimits?: boolean; sileroVadEnabled?: boolean; dynaudnormEnabled?: boolean; vadFactory?: (sampleRate: number, config?: VadConfig) => BoundaryVad }, private readonly transport: AsrTransport) {
    this.prompt = profile.prompt
    this.vadConfig = profile.vadConfig ?? { ...defaultVadConfig }
  }

  async start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {
    if (!this.profile.endpoint.trim() || !this.profile.model.trim()) throw new Error(activeTranslate('svcAsrEndpointRequired'))
    await this.transport.ensureReady()
    this.sampleRate = input.sampleRate
    // An empty value deliberately omits OpenAI's optional `language` field and
    // lets the ASR model identify Chinese, English, Japanese, or German.
    this.language = input.language === 'auto' ? '' : input.language.split('-')[0]
    this.pendingChunks = []
    this.pendingSamples = 0
    this.pendingStart = 0
    this.speechOnsets = []
    this.queued = Promise.resolve()
    this.sequence = 0
    this.stopped = false
    this.queuedChunks = 0
    this.vad = this.createVad()
    this.pendingContainsSpeech = false
    this.pendingBoundaries = []
    this.explicitBoundaries.clear()
    this.vadSpeaking = false
    this.lastSpeechSample = 0
    this.lastVoicedSample = 0
    this.rollingContext = ''
    this.lastTranscript = undefined
    this.overflowGap = undefined
    Object.keys(this.diagnostics).forEach((key) => { this.diagnostics[key as keyof typeof this.diagnostics] = 0 })
  }

  /** The boundary detector is swappable so evaluations can compare detectors
   * (e.g. Silero probabilities) against the default RMS EnergyVad. */
  private createVad(): BoundaryVad {
    return this.profile.vadFactory ? this.profile.vadFactory(this.sampleRate, this.vadConfig) : new EnergyVad(this.sampleRate, this.vadConfig)
  }

  pushAudio(chunk: Float32Array, startSample: number): void {
    if (this.stopped) return
    this.audioClock = { sample: startSample + chunk.length, at: performance.now() }
    const vadFrame = this.vad?.process(chunk)
    if (vadFrame?.speechStarted) {
      recordCaptionEvent('speech_detected')
      const now = performance.now()
      this.speechOnsets.push({ sample: startSample + chunk.length - vadFrame.onsetSamples, at: now - vadFrame.onsetSamples / this.sampleRate * 1000, detected: now })
      this.speechOnsets = this.speechOnsets.slice(-256)
    }
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
    if (this.vadSpeaking || vadFrame?.speechStarted || vadFrame?.speechEnded) this.lastVoicedSample = startSample + chunk.length - (vadFrame?.trailingSilenceSamples ?? 0)
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
      const maximum = Math.floor(this.sampleRate * Math.min(6000, configuredMaximum * (!this.profile.strictChunkLimits && this.queuedChunks >= 2 ? 2 : 1)) / 1000)
      const boundary = this.pendingBoundaries[0]
      const minimum = this.profile.strictChunkLimits ? Math.floor(this.sampleRate * (this.vadConfig?.chunkMinMs ?? 700) / 1000) : 0
      const explicit = boundary !== undefined && this.explicitBoundaries.has(boundary)
      const toBoundary = boundary === undefined ? Infinity : Math.max(explicit ? 0 : minimum, boundary - this.pendingStart)
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
    if (this.vad?.reset) this.vad.reset()
    else this.vad = this.createVad()
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
      const stopMaximum = this.profile.strictChunkLimits ? (this.vadConfig?.chunkMaxMs ?? 6000) / 1000 : 6
      const size = Math.min(this.pendingSamples, this.sampleRate * stopMaximum, boundary === undefined ? Infinity : boundary - start)
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
    return this.listeners.subscribe(listener)
  }
  onError(listener: (message: string) => void): () => void {
    return this.errorListeners.subscribe(listener)
  }
  updateLiveSettings(input: { language?: string; prompt?: string; vadConfig?: VadConfig; strictChunkLimits?: boolean }): void {
    if (input.strictChunkLimits !== undefined) this.profile.strictChunkLimits = input.strictChunkLimits
    if (input.language !== undefined) this.language = input.language === 'auto' ? '' : input.language.split('-')[0]
    if (input.prompt !== undefined) this.prompt = input.prompt || undefined
    if (input.vadConfig) {
      this.vadConfig = input.vadConfig
      this.vad = this.createVad()
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
    const queuedAt = performance.now()
    // First speech in this chunk, not the start of the whole continuous utterance.
    // Sample-clock backdating retains collection time even when the queue is full.
    const chunkStartAt = this.audioClock.at - (this.audioClock.sample - startSample) / this.sampleRate * 1000
    const chunkOnset = this.speechOnsets.find(onset => onset.sample >= startSample && onset.sample < endSample)
    const speechEndSample = Math.min(endSample, this.lastVoicedSample)
    const speechEndAt = speechEndSample > startSample ? this.audioClock.at - (this.audioClock.sample - speechEndSample) / this.sampleRate * 1000 : undefined
    const chunkSpeechAt = chunkOnset?.at ?? chunkStartAt
    const chunkDetectedAt = chunkOnset ? Math.max(chunkSpeechAt, Math.min(queuedAt, chunkOnset.detected)) : chunkSpeechAt
    this.queued = this.queued.catch(() => undefined).then(async () => {
      this.diagnostics.totalQueueWaitMs += Date.now() - enqueuedAt
      const dequeuedAt = performance.now()
      const wav = wavFromFloat32(audio, this.sampleRate)
      // <300ms 微型 chunk 豁免（2026-10 校準）：快切碎音結構性湊不出 Silero
      // 的 120ms 連續語音，硬送會誤殺真語音（實測誤殺全為 20-220ms、被攔的
      // BGM 全 ≥1200ms）。豁免同時省下一次閘門 HTTP。
      let sileroStartAt: number | undefined
      let sileroEndAt: number | undefined
      if (this.profile.sileroVadEnabled && audio.length / this.sampleRate * 1_000 >= 300) {
        let hasSpeech = true
        sileroStartAt = performance.now()
        try {
          hasSpeech = await this.hasSileroSpeech(wav)
        } catch (error) {
          // An auxiliary gate failure degrades to the ungated path so a
          // Silero outage cannot silence captions; the distinct event keeps
          // the failure rate visible instead of counting it as ASR failure.
          recordCaptionEvent('silero_failed')
          this.emitError(error instanceof Error ? error.message : activeTranslate('svcSileroGatewayFailed').replace('{status}', '?'))
        }
        sileroEndAt = performance.now()
        if (!hasSpeech) {
          recordCaptionEvent('silero_veto')
          this.rollingContext = ''
          this.speechOnsets = this.speechOnsets.filter(onset => onset.sample >= endSample)
          if (isSentenceBoundary || this.explicitBoundaries.has(endSample)) this.closePreviousCaption(startMs)
          return
        }
      }
      const requestAt = performance.now()
      const response = await this.transcribeWithRetry(wav)
      const responseAt = performance.now()
      const sourceText = sanitizeAsrText(response.text)
      // t4：標點符號／不雅字等文字後處理的量測窗口（目前僅有清理步驟）。
      const repetitive = isRepetitiveAsrText(sourceText)
      const postEndAt = performance.now()
      if (!sourceText || repetitive) {
        recordCaptionEvent('asr_empty')
        // A failed/looping response must not condition subsequent requests
        // with stale text and keep the decoder in a self-repeating loop.
        this.rollingContext = ''
        this.speechOnsets = this.speechOnsets.filter(onset => onset.sample >= endSample)
        if (isSentenceBoundary || this.explicitBoundaries.has(endSample)) this.closePreviousCaption(startMs)
        return
      }
      this.rollingContext = sourceText
      const event: TranscriptEvent = { id: `http-${sequence}`, revision: 1, status: 'final', startMs, endMs, sourceText, detectedLanguage: response.detectedLanguage, isSentenceBoundary: isSentenceBoundary || this.explicitBoundaries.has(endSample) }
      const onsets = this.speechOnsets.filter(onset => onset.sample < endSample && onset.sample >= startSample - this.sampleRate * 30)
      this.speechOnsets = this.speechOnsets.filter(onset => onset.sample >= endSample)
      const timing: CaptionTiming = {
        chunkSpeechAt, chunkDetectedAt, queuedAt, dequeuedAt, requestAt, responseAt, postEndAt, speechEndAt,
        ...(sileroStartAt !== undefined && sileroEndAt !== undefined ? { sileroStartAt, sileroEndAt } : {}),
        ...(response.server ? { server: response.server } : {}),
        ...(onsets[0] ? { speechAt: onsets[0].at } : {})
      }
      attachCaptionTiming(event, timing)
      this.lastTranscript = event
      this.listeners.emit(event)
    }).catch((error: unknown) => {
      recordCaptionEvent('asr_failed')
      this.rollingContext = ''
      this.speechOnsets = this.speechOnsets.filter(onset => onset.sample >= endSample)
      this.emitError(error instanceof Error ? error.message : activeTranslate('svcModelTranscribeFailed'))
      this.emitGap(sequence, startMs, endMs, 'request-failed')
    }).finally(() => {
      this.queuedChunks -= 1
      this.explicitBoundaries.delete(endSample)
      if (!this.stopped) this.flushPending()
    })
  }

  private recordOverflow(startMs: number, endMs: number): void {
    recordCaptionEvent('audio_gap')
    this.speechOnsets = this.speechOnsets.filter(onset => onset.sample / this.sampleRate * 1000 >= endMs)
    if (!this.overflowGap || this.overflowGap.endMs !== startMs) {
      this.flushOverflow()
      this.emitError(activeTranslate('svcModelTooSlow'))
      this.diagnostics.gaps += 1
      this.overflowGap = { id: `gap-${this.sequence++}`, revision: 1, status: 'gap', startMs, endMs, sourceText: '', gapReason: 'queue-overflow', emittedEndMs: endMs }
      const { emittedEndMs: _, ...event } = this.overflowGap
      this.listeners.emit(event)
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
    this.listeners.emit(event)
  }

  private flushOverflow(): void {
    this.emitOverflow()
    this.overflowGap = undefined
  }

  private closePreviousCaption(startMs: number): void {
    const previous = this.lastTranscript
    if (!previous || previous.isSentenceBoundary || previous.endMs !== startMs) return
    this.lastTranscript = { ...previous, revision: previous.revision + 1, isSentenceBoundary: true }
    this.listeners.emit({ ...this.lastTranscript!, boundaryOnly: true })
  }

  private emitGap(sequence: number, startMs: number, endMs: number, gapReason: TranscriptEvent['gapReason']): void {
    this.diagnostics.gaps += 1
    const event: TranscriptEvent = { id: `gap-${sequence}`, revision: 1, status: 'gap', startMs, endMs, sourceText: '', gapReason }
    this.listeners.emit(event)
  }

  private async transcribeWithRetry(audio: ArrayBuffer): Promise<{ text: string; detectedLanguage?: TranscriptEvent['detectedLanguage']; server?: CaptionServerTiming }> {
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
          const result = await this.transport.transcribe({ ...request, audio })
          this.diagnostics.completed += 1
          return result
        } finally { this.diagnostics.inFlight -= 1; this.diagnostics.totalRequestMs += Date.now() - startedAt }
      } catch (error) {
        // A hung gateway must release the live-caption queue immediately;
        // retrying the same timed-out request would leave the screen stalled.
        if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw error
        // Authentication, validation and unsupported-model errors cannot be
        // repaired by resending the same audio. Keep retries for transient errors.
        if (error instanceof HttpServiceError && error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status)) throw error
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

  private hasSileroSpeech(audio: ArrayBuffer): Promise<boolean> { return this.transport.hasSpeech(audio) }

  private emitError(message: string): void {
    this.errorListeners.emit(message)
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

}
