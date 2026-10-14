import type { ModelAdapter } from '../contracts'
import type { TranscriptEvent } from '../../../../../shared/contracts/transcript'
import { EventChannel } from '../../../shared/events/event-channel'
import { activeTranslate } from '../../../shared/i18n'
import { sanitizeAsrText } from '../domain/asr-text'
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
  readonly capabilities = { pauseBoundary: false, liveSettings: false }
  private socket: WebSocket | null = null
  private listeners = new EventChannel<TranscriptEvent>()
  private sequence = 0
  private streamId = ''
  private stopping = false
  private lastBackpressureWarning = 0
  private errorListeners = new EventChannel<string>()

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
    return this.listeners.subscribe(listener)
  }
  onError(listener: (message: string) => void): () => void {
    return this.errorListeners.subscribe(listener)
  }

  private emitError(message: string): void {
    this.errorListeners.emit(message)
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
      this.listeners.emit(transcript)
    } catch {
      // Ignore malformed server frames while retaining the recording.
    }
  }
}

