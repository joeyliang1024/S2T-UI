import type { ResponseSpeed } from '../../../../shared/response-speed'
export { normalizeResponseSpeed, responseSpeeds } from '../../../../shared/response-speed'
export type { ResponseSpeed } from '../../../../shared/response-speed'

export type VadFrame = {
  onsetSamples: number
  speechStarted: boolean
  speechEnded: boolean
  speaking: boolean
  levelDbfs: number
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

export const defaultVadConfig: VadConfig = {
  minSpeechMs: 120,
  // Natural silence endpoints dispatch before the selected request bound.
  minSilenceMs: 250,
  preRollMs: 300,
  noiseFloorOffsetDb: 12,
  // Normal is the middle setting; the validated 6000/250 CER-first
  // configuration belongs to Slow. See docs/guide/CAPTION_SPEED.zh-TW.md.
  chunkMinMs: 700,
  chunkMaxMs: 3_000
}

/**
 * Five positions, with visible labels only at Fast, Normal and Slow.
 * Existing saved values retain their semantic position; the two intermediate
 * values are persisted explicitly so settings reload does not collapse them.
 */
export const responseSpeedVadConfig: Record<ResponseSpeed, VadConfig> = {
  fast: { ...defaultVadConfig, minSilenceMs: 150, chunkMaxMs: 1_200 },
  'fast-normal': { ...defaultVadConfig, chunkMaxMs: 1_500 },
  normal: { ...defaultVadConfig },
  'normal-slow': { ...defaultVadConfig, chunkMaxMs: 4_000 },
  // The full-fixture 6000/250 result (CER 10.34%, display P95 5.546s)
  // is assigned exactly to Slow, including its 700ms minimum setting.
  slow: { ...defaultVadConfig, chunkMaxMs: 6_000 }
}

export const speedToVadConfig = (speed: ResponseSpeed): VadConfig => ({ ...responseSpeedVadConfig[speed] })

/**
 * An app-side VAD for a request/response ASR service. It chooses better HTTP
 * chunk boundaries and suppresses room tone; it does not claim word timing.
 */
export class EnergyVad implements BoundaryVad {
  private speaking = false
  private onsetSamples = 0
  private silenceSamples = 0
  private noiseFloorDbfs = -60

  constructor(private readonly sampleRate: number, private readonly config: VadConfig = defaultVadConfig) {}

  reset(): void {
    this.speaking = false
    this.onsetSamples = 0
    this.silenceSamples = 0
  }

  process(samples: Float32Array): VadFrame {
    let sum = 0
    for (const sample of samples) sum += sample * sample
    const rms = Math.sqrt(sum / Math.max(samples.length, 1))
    const levelDbfs = rms > 0 ? Math.max(-80, 20 * Math.log10(rms)) : -80
    const startThreshold = Math.max(-42, Math.min(-24, this.noiseFloorDbfs + this.config.noiseFloorOffsetDb))
    // Do not learn a potential voice onset as noise while waiting for
    // minSpeechMs. AudioWorklet frames are only 128 samples: a per-call
    // adaptation rate otherwise raises the threshold before speech starts.
    if (!this.speaking && levelDbfs < startThreshold && this.onsetSamples === 0) {
      const weight = 1 - Math.pow(0.98, samples.length / (this.sampleRate * 0.01))
      this.noiseFloorDbfs += weight * (levelDbfs - this.noiseFloorDbfs)
    }
    const stopThreshold = startThreshold - 5
    const minimumOnset = Math.floor(this.sampleRate * this.config.minSpeechMs / 1000)
    const minimumSilence = Math.floor(this.sampleRate * this.config.minSilenceMs / 1000)
    let speechStarted = false
    let speechEnded = false

    if (!this.speaking) {
      if (levelDbfs >= startThreshold) {
        this.onsetSamples += samples.length
        if (this.onsetSamples >= minimumOnset) {
          this.speaking = true
          this.silenceSamples = 0
          speechStarted = true
        }
      } else this.onsetSamples = 0
    } else if (levelDbfs <= stopThreshold) {
      this.silenceSamples += samples.length
      if (this.silenceSamples >= minimumSilence) {
        this.speaking = false
        this.onsetSamples = 0
        speechEnded = true
      }
    } else this.silenceSamples = 0

    return { onsetSamples: this.onsetSamples, speechStarted, speechEnded, speaking: this.speaking, levelDbfs }
  }
}
