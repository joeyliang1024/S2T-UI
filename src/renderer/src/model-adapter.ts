export type TranscriptEvent = {
  id: string
  revision: number
  status: 'partial' | 'final'
  startMs: number
  endMs: number
  sourceText: string
  translatedText?: string
  speaker?: string
}

export interface ModelAdapter {
  start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void>
  pushAudio(chunk: Float32Array, startSample: number): void
  stop(): Promise<void>
  onTranscript(listener: (event: TranscriptEvent) => void): () => void
}

/**
 * A deliberately quiet placeholder. Replace this with the adapter for the
 * user-supplied model without changing the capture or subtitle UI contracts.
 */
export class NoopModelAdapter implements ModelAdapter {
  private listeners = new Set<(event: TranscriptEvent) => void>()

  async start(_input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {}
  pushAudio(_chunk: Float32Array, _startSample: number): void {}
  async stop(): Promise<void> {}
  onTranscript(listener: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
        reject(new Error('無法連線至模型服務'))
      }
      socket.onmessage = (message) => this.handleMessage(message.data)
      socket.onclose = () => { if (this.socket === socket) this.socket = null }
    })
  }

  pushAudio(chunk: Float32Array, startSample: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (this.socket.bufferedAmount > 2 * 1024 * 1024) return
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
  private sampleRate = 48_000
  private language = 'zh'
  private pending = new Float32Array(0)
  private pendingStart = 0
  private queued = Promise.resolve()
  private sequence = 0
  private stopped = false

  constructor(private readonly profile: { id: string; endpoint: string; model: string; prompt?: string }) {}

  async start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {
    if (!window.s2t) throw new Error('OpenAI 相容轉錄僅能在 Electron 應用程式中使用')
    if (!this.profile.endpoint.trim() || !this.profile.model.trim()) throw new Error('請設定轉錄 API 位址與模型名稱')
    if (!(await window.s2t.hasModelApiKey(this.profile.id))) throw new Error('請先在設定頁儲存此模型的 API key')
    this.sampleRate = input.sampleRate
    this.language = input.language.split('-')[0]
    this.pending = new Float32Array(0)
    this.pendingStart = 0
    this.queued = Promise.resolve()
    this.sequence = 0
    this.stopped = false
  }

  pushAudio(chunk: Float32Array, startSample: number): void {
    if (this.stopped) return
    if (this.pending.length === 0) this.pendingStart = startSample
    const merged = new Float32Array(this.pending.length + chunk.length)
    merged.set(this.pending)
    merged.set(chunk, this.pending.length)
    this.pending = merged
    const maximumChunkSamples = Math.floor(this.sampleRate * 3)
    const minimumChunkSamples = Math.floor(this.sampleRate * 1.2)
    const rms = Math.sqrt(chunk.reduce((sum, sample) => sum + sample * sample, 0) / chunk.length)
    const reachedNaturalBoundary = this.pending.length >= minimumChunkSamples && rms < 0.012
    while (this.pending.length >= maximumChunkSamples || reachedNaturalBoundary) {
      const size = reachedNaturalBoundary ? this.pending.length : maximumChunkSamples
      const audio = this.pending.slice(0, size)
      const start = this.pendingStart
      this.pending = this.pending.slice(size)
      this.pendingStart += size
      this.enqueue(audio, start)
      if (this.pending.length < minimumChunkSamples) break
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.pending.length) this.enqueue(this.pending, this.pendingStart)
    this.pending = new Float32Array(0)
    await this.queued
  }

  onTranscript(listener: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private enqueue(audio: Float32Array, startSample: number): void {
    const sequence = this.sequence++
    this.queued = this.queued.then(async () => {
      if (!window.s2t) return
      const response = await window.s2t.transcribeAudioChunk({
        profileId: this.profile.id, endpoint: this.profile.endpoint, model: this.profile.model,
        language: this.language, prompt: this.profile.prompt, audio: wavFromFloat32(audio, this.sampleRate)
      })
      const sourceText = response.text.trim()
      if (!sourceText) return
      const startMs = Math.round(startSample / this.sampleRate * 1000)
      const endMs = Math.round((startSample + audio.length) / this.sampleRate * 1000)
      const event: TranscriptEvent = { id: `http-${sequence}`, revision: 1, status: 'final', startMs, endMs, sourceText }
      this.listeners.forEach((listener) => listener(event))
    })
  }
}
