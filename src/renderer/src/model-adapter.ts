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
