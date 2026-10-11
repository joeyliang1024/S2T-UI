import type { BoundaryVad, VadConfig, VadFrame } from './vad'

/**
 * A VAD whose sentence boundaries come from Silero frame probabilities
 * instead of RMS energy. It is renderer-safe: the ONNX session stays in Node
 * (Electron main or the evaluation harness) and is injected as a plain
 * Float32Array of per-window probabilities, one per 512-sample window at
 * 16 kHz (32 ms each) — the exact window the upstream Silero wrapper scores.
 *
 * The hysteresis contract matches EnergyVad: `minSpeechMs` of voiced windows
 * starts an utterance, `minSilenceMs` of unvoiced windows ends it, and the
 * VadFrame flags are synchronous so OpenAiChunkedModelAdapter needs no change.
 */
export class SileroBoundaryVad implements BoundaryVad {
  private speaking = false
  private voicedSamples = 0
  private silentSamples = 0
  private onset16k = 0
  private cursor = 0
  private nextWindow = 0

  private readonly windowSamples = 512
  private readonly rateRatio: number
  private readonly minimumVoiced: number
  private readonly minimumSilent: number

  constructor(
    private readonly sampleRate: number,
    private readonly config: VadConfig,
    /** Per-window Silero probability at 16 kHz, in playback order. */
    private readonly probabilities: Float32Array,
    private readonly threshold = 0.5
  ) {
    this.rateRatio = 16_000 / sampleRate
    this.minimumVoiced = Math.max(this.windowSamples, Math.floor(16_000 * config.minSpeechMs / 1_000))
    this.minimumSilent = Math.max(this.windowSamples, Math.floor(16_000 * config.minSilenceMs / 1_000))
  }

  process(samples: Float32Array): VadFrame {
    let sum = 0
    for (const sample of samples) sum += sample * sample
    const rms = samples.length ? Math.sqrt(sum / samples.length) : 0
    const levelDbfs = rms > 0 ? Math.max(-80, 20 * Math.log10(rms)) : -80

    this.cursor += samples.length
    const end16k = Math.floor(this.cursor * this.rateRatio)
    let speechStarted = false
    let speechEnded = false
    // Score a window only once its 512 samples are fully covered by pushed
    // audio: input batches (128 samples at 48 kHz) rarely align to window
    // edges, and scoring a straddling window twice would double-count the
    // voiced onset and fire speechStarted early. The final partial window is
    // deliberately never scored — flush() closes the tail explicitly.
    while ((this.nextWindow + 1) * this.windowSamples <= end16k) {
      const windowStart = this.nextWindow * this.windowSamples
      const voiced = (this.probabilities[this.nextWindow] ?? 0) >= this.threshold
      this.nextWindow += 1
      if (voiced) {
        if (this.speaking) { this.silentSamples = 0; continue }
        if (this.voicedSamples === 0) this.onset16k = windowStart
        this.voicedSamples += this.windowSamples
        this.silentSamples = 0
        if (this.voicedSamples >= this.minimumVoiced) {
          this.speaking = true
          speechStarted = true
        }
      } else if (this.speaking) {
        this.silentSamples += this.windowSamples
        if (this.silentSamples >= this.minimumSilent) {
          this.speaking = false
          this.voicedSamples = 0
          speechEnded = true
        }
      } else this.voicedSamples = 0
    }

    // Samples elapsed since the utterance onset began, in input-rate units:
    // the adapter maps this back to the exact onset sample for caption timing.
    const onsetSamples = this.speaking
      ? Math.max(0, Math.round(this.cursor - this.onset16k / this.rateRatio))
      : 0
    return { onsetSamples, speechStarted, speechEnded, speaking: this.speaking, levelDbfs }
  }
}
