export type VadFrame = {
  speechStarted: boolean
  speechEnded: boolean
  speaking: boolean
  levelDbfs: number
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
  // 250 ms keeps sentence-endpoint latency inside the 2.5 s budget;
  // canMergeHttpCaption re-joins the shorter segments for display.
  minSilenceMs: 250,
  preRollMs: 300,
  noiseFloorOffsetDb: 12,
  // 700/1500 ms bounds the wait before the first caption: continuous speech
  // reaches the ASR at ~1.2 s instead of ~2.1 s from the speaker's first word.
  chunkMinMs: 700,
  chunkMaxMs: 1_500
}

/**
 * The only user-facing caption control. Each tier is a curated VadConfig
 * measured by scripts/evaluation/caption-latency-eval.cjs on conversational speech:
 * 'fast' shows captions earliest (shorter, occasionally choppier clips),
 * 'normal' is the validated P95 ≤ 2.5 s configuration, 'slow' waits for
 * longer clips (steadier output, later on screen).
 */
export type ResponseSpeed = 'fast' | 'normal' | 'slow'

export const responseSpeeds: ReadonlyArray<ResponseSpeed> = ['fast', 'normal', 'slow']

export const responseSpeedVadConfig: Record<ResponseSpeed, VadConfig> = {
  // Measured on conversational speech: 700/1200 keeps CER level with 'normal'
  // (35.2% corpus) while cutting median display latency ~270 ms; an earlier
  // 500/1000 attempt lost 4 of 32 sentences to empty ASR output on short clips.
  // On clean narration, chunkMin 500 gained nothing over 700 (p50 1219 vs
  // 1164 ms, corpus CER 14.2% vs 14.0%), so 700 stays.
  fast: { ...defaultVadConfig, minSilenceMs: 150, chunkMaxMs: 1_200 },
  normal: { ...defaultVadConfig },
  // minSilence 800 (not 500): on clean narration it holds clips across short
  // pauses instead of cutting at them — corpus CER 8.35% vs 10.27%, with 0
  // premature natural cuts vs 2. On BGM material no boundary ever fires, so
  // the tier behaves exactly like 500 there (corpus CER 28.88% unchanged).
  slow: { ...defaultVadConfig, minSilenceMs: 800, chunkMinMs: 1_000, chunkMaxMs: 2_400 }
}

export const normalizeResponseSpeed = (value: unknown): ResponseSpeed => value === 'fast' || value === 'slow' ? value : 'normal'

export const speedToVadConfig = (speed: ResponseSpeed): VadConfig => ({ ...responseSpeedVadConfig[speed] })

/**
 * An app-side VAD for a request/response ASR service. It chooses better HTTP
 * chunk boundaries and suppresses room tone; it does not claim word timing.
 */
export class EnergyVad {
  private speaking = false
  private onsetSamples = 0
  private silenceSamples = 0
  private noiseFloorDbfs = -60

  constructor(private readonly sampleRate: number, private readonly config: VadConfig = defaultVadConfig) {}

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

    return { speechStarted, speechEnded, speaking: this.speaking, levelDbfs }
  }
}
