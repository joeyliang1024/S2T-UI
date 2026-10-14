import type { TranscriptEvent } from '../../../../shared/contracts/transcript'
import type { VadConfig } from '../../../../shared/contracts/capture'
export interface ModelAdapter {
  readonly capabilities?: { pauseBoundary: boolean; liveSettings: boolean }
  start(input: { sampleRate: number; language: string; targetLanguage: string }): Promise<void>
  pushAudio(chunk: Float32Array, startSample: number): void
  stop(): Promise<void>
  /** Mark a pause boundary without ending the capture session. */
  flush?(): void
  onTranscript(listener: (event: TranscriptEvent) => void): () => void
  onError(listener: (message: string) => void): () => void
  /** Applies settings to audio received after this call; it never restarts capture. */
  updateLiveSettings?(input: { language?: string; prompt?: string; vadConfig?: VadConfig; strictChunkLimits?: boolean }): void
}
