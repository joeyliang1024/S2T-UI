export type VadFrame = {
  onsetSamples: number
  speechStarted: boolean
  speechEnded: boolean
  speaking: boolean
  levelDbfs: number
  /** Samples since the most recent voiced audio, excluding VAD silence confirmation. */
  trailingSilenceSamples?: number
}

/**
 * The synchronous contract OpenAiChunkedModelAdapter needs from any boundary
 * detector. EnergyVad (RMS) and SileroBoundaryVad (ML) both satisfy it, and
 * the adapter accepts a factory so evaluations or future on-device runtimes
 * can swap the detector without touching the chunking logic.
 */
export interface BoundaryVad {
  process(samples: Float32Array): VadFrame
  /** Clear utterance state while retaining the detector's audio position. */
  reset?(): void
}

export type VadConfig = {
  minSpeechMs: number
  minSilenceMs: number
  preRollMs: number
  noiseFloorOffsetDb: number
  /** Lower and upper limits for each HTTP ASR request. */
  chunkMinMs: number
  chunkMaxMs: number
}

