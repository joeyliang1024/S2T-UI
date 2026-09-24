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
}

export const defaultVadConfig: VadConfig = {
  minSpeechMs: 120,
  minSilenceMs: 500,
  preRollMs: 300,
  noiseFloorOffsetDb: 12
}

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
    if (!this.speaking && levelDbfs < -20) this.noiseFloorDbfs = this.noiseFloorDbfs * 0.98 + levelDbfs * 0.02
    const startThreshold = Math.max(-42, Math.min(-24, this.noiseFloorDbfs + this.config.noiseFloorOffsetDb))
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
