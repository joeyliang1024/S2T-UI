import type { ModelAdapter } from '../contracts'
import type { TranscriptEvent } from '../../../../shared/contracts/transcript'
import { EventChannel } from '../../../shared/events/event-channel'
export class NoopModelAdapter implements ModelAdapter {
  readonly capabilities = { pauseBoundary: false, liveSettings: false }
  private listeners = new EventChannel<TranscriptEvent>()
  private errorListeners = new EventChannel<string>()

  async start(_input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void> {}
  pushAudio(_chunk: Float32Array, _startSample: number): void {}
  async stop(): Promise<void> {}
  onTranscript(listener: (event: TranscriptEvent) => void): () => void {
    return this.listeners.subscribe(listener)
  }
  onError(listener: (message: string) => void): () => void {
    return this.errorListeners.subscribe(listener)
  }
}

