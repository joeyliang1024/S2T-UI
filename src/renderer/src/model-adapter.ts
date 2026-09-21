import { EnergyVad, type VadConfig } from './vad'

export type TranscriptEvent = {
  id: string
  revision: number
  status: 'partial' | 'final' | 'gap'
  startMs: number
  endMs: number
  sourceText: string
  translatedText?: string
  speaker?: string
  translationStatus?: 'failed'
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
}

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
}

/**
 * Generic WebSocket transport for the self-hosted STT service contract in
 * docs/MODEL_ADAPTER.md. It deliberately keeps recognition logic server-side.
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
        reject(new Error('模型連線逾時'))
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
        if (this.socket === socket) this.emitError('模型 WebSocket 連線發生錯誤')
        reject(new Error('無法連線至模型服務'))
      }
      socket.onmessage = (message) => this.handleMessage(message.data)
      socket.onclose = () => {
        if (this.socket !== socket) return
        this.socket = null
        if (!this.stopping) this.emitError('模型 WebSocket 已中斷；錄音仍會繼續保存')
      }
    })
  }

  pushAudio(chunk: Float32Array, startSample: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (this.socket.bufferedAmount > 2 * 1024 * 1024) {
      if (Date.now() - this.lastBackpressureWarning > 5_000) {
        this.lastBackpressureWarning = Date.now()
        this.emitError('模型處理過慢，部分即時字幕音訊已略過；完整錄音仍會保存')
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
        startMs: event.startMs, endMs: event.endMs, sourceText: event.sourceText,
        translatedText: typeof event.translatedText === 'string' ? event.translatedText : undefined
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

  constructor(private readonly profile: { id: string; endpoint: string; model: string; prompt?: string; vadConfig?: VadConfig }) {}

  async start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {
    if (!this.profile.endpoint.trim() || !this.profile.model.trim()) throw new Error('請設定轉錄 API 位址與模型名稱')
    if (window.s2t && !(await window.s2t.hasModelApiKey(this.profile.id))) throw new Error('請先在設定頁儲存此模型的 API key')
    if (!window.s2t && this.profile.id !== 'web-environment-asr') throw new Error('Web 版只能使用網站管理者設定的 ASR 模型')
    this.sampleRate = input.sampleRate
    this.language = input.language.split('-')[0]
    this.pendingChunks = []
    this.pendingSamples = 0
    this.pendingStart = 0
    this.queued = Promise.resolve()
    this.sequence = 0
    this.stopped = false
    this.queuedChunks = 0
    this.vad = new EnergyVad(this.sampleRate, this.profile.vadConfig)
    this.pendingContainsSpeech = false
  }

  pushAudio(chunk: Float32Array, startSample: number): void {
    if (this.stopped) return
    const vadFrame = this.vad?.process(chunk)
    if (this.pendingSamples === 0) this.pendingStart = startSample
    this.pendingChunks.push(chunk)
    this.pendingSamples += chunk.length
    // Breeze-ASR is non-streaming. A short ceiling keeps the perceived latency
    // near one second without shipping frames too small for stable recognition.
    const maximumChunkSamples = Math.floor(this.sampleRate * 1.5)
    const minimumChunkSamples = Math.floor(this.sampleRate * 0.8)
    this.pendingContainsSpeech ||= Boolean(vadFrame?.speechStarted || vadFrame?.speaking)
    const reachedNaturalBoundary = this.pendingSamples >= minimumChunkSamples && Boolean(vadFrame?.speechEnded)
    // Keep 300 ms of room tone before a voice onset, but avoid sending empty
    // requests while nobody is speaking.
    if (!this.pendingContainsSpeech && this.pendingSamples > maximumChunkSamples) {
      const preRollSamples = Math.floor(this.sampleRate * (this.profile.vadConfig?.preRollMs ?? 300) / 1000)
      this.discardPending(this.pendingSamples - preRollSamples)
      return
    }
    while (this.pendingSamples >= maximumChunkSamples || reachedNaturalBoundary) {
      const size = reachedNaturalBoundary ? this.pendingSamples : maximumChunkSamples
      const start = this.pendingStart
      const audio = this.takePending(size)
      this.enqueue(audio, start)
      this.pendingContainsSpeech = Boolean(vadFrame?.speaking)
      if (this.pendingSamples < minimumChunkSamples) break
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.pendingSamples && this.pendingContainsSpeech) {
      const start = this.pendingStart
      this.enqueue(this.takePending(this.pendingSamples), start)
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

  private enqueue(audio: Float32Array, startSample: number): void {
    const sequence = this.sequence++
    const startMs = Math.round(startSample / this.sampleRate * 1000)
    const endMs = Math.round((startSample + audio.length) / this.sampleRate * 1000)
    if (this.queuedChunks >= this.maximumQueuedChunks) {
      this.emitError('模型處理過慢，部分即時字幕音訊已略過；完整錄音仍會保存')
      this.emitGap(sequence, startMs, endMs, 'queue-overflow')
      return
    }
    this.queuedChunks += 1
    this.queued = this.queued.catch(() => undefined).then(async () => {
      const wav = wavFromFloat32(audio, this.sampleRate)
      const response = await this.transcribeWithRetry(wav)
      const sourceText = response.text.trim()
      if (!sourceText) return
      const event: TranscriptEvent = { id: `http-${sequence}`, revision: 1, status: 'final', startMs, endMs, sourceText }
      this.listeners.forEach((listener) => listener(event))
    }).catch((error: unknown) => {
      this.emitError(error instanceof Error ? error.message : '模型轉錄失敗')
      this.emitGap(sequence, startMs, endMs, 'request-failed')
    }).finally(() => { this.queuedChunks -= 1 })
  }

  private emitGap(sequence: number, startMs: number, endMs: number, gapReason: TranscriptEvent['gapReason']): void {
    const event: TranscriptEvent = { id: `gap-${sequence}`, revision: 1, status: 'gap', startMs, endMs, sourceText: '', gapReason }
    this.listeners.forEach((listener) => listener(event))
  }

  private async transcribeWithRetry(audio: ArrayBuffer): Promise<{ text: string }> {
    const delays = [0, 250, 750, 1750]
    let lastError: unknown
    for (const delay of delays) {
      if (delay) await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
      try {
        return window.s2t ? await window.s2t.transcribeAudioChunk({
          profileId: this.profile.id, endpoint: this.profile.endpoint, model: this.profile.model,
          language: this.language, prompt: this.profile.prompt, audio
        }) : await this.transcribeThroughWebGateway(audio)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('模型轉錄失敗')
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

  private async transcribeThroughWebGateway(audio: ArrayBuffer): Promise<{ text: string }> {
    const response = await fetch('/api/transcriptions', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'x-s2t-language': this.language,
        ...(this.profile.prompt ? { 'x-s2t-prompt': this.profile.prompt } : {})
      },
      body: audio
    })
    const payload = await response.json() as { text?: string; error?: string }
    if (!response.ok) throw new Error(payload.error || `Web ASR gateway failed (${response.status})`)
    return { text: payload.text || '' }
  }
}
