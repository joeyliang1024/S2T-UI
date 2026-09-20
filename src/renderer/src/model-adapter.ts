export type TranscriptEvent = {
  id: string
  revision: number
  status: 'partial' | 'final'
  startMs: number
  endMs: number
  sourceText: string
  translatedText?: string
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
        socket.send(JSON.stringify({
          type: 'start', audioFormat: 'f32le', channels: 1,
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

  pushAudio(chunk: Float32Array, _startSample: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    if (this.socket.bufferedAmount > 2 * 1024 * 1024) return
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
