/**
 * Streaming linear resampler for the ASR branch.  Recording continues at the
 * device's native rate; only the bytes delivered to the configured model are
 * converted.  The fractional cursor is retained between AudioWorklet frames.
 */
export class StreamingResampler {
  private cursor = 0
  private tail = new Float32Array(0)
  private readonly antiAliasKernel: Float32Array
  private filterHistory = new Float32Array(0)

  constructor(private readonly sourceRate: number, private readonly targetRate: number) {
    this.antiAliasKernel = sourceRate > targetRate ? StreamingResampler.lowPassKernel(targetRate / sourceRate) : new Float32Array(0)
    this.filterHistory = new Float32Array(Math.max(0, this.antiAliasKernel.length - 1))
  }

  private static lowPassKernel(ratio: number): Float32Array {
    // Windowed-sinc low pass before decimation. Keeping the cutoff below the
    // target Nyquist frequency leaves a small transition band and avoids the
    // aliasing produced by plain linear interpolation.
    const taps = 33
    const center = (taps - 1) / 2
    const cutoff = Math.min(.49, Math.max(.01, ratio * .45))
    const values = new Float32Array(taps)
    let sum = 0
    for (let index = 0; index < taps; index += 1) {
      const offset = index - center
      const sinc = offset === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset)
      const window = .54 - .46 * Math.cos(2 * Math.PI * index / (taps - 1))
      values[index] = sinc * window
      sum += values[index]
    }
    for (let index = 0; index < taps; index += 1) values[index] /= sum
    return values
  }

  private filter(input: Float32Array): Float32Array {
    if (!this.antiAliasKernel.length) return input
    const source = new Float32Array(this.filterHistory.length + input.length)
    source.set(this.filterHistory)
    source.set(input, this.filterHistory.length)
    const filtered = new Float32Array(input.length)
    const historyLength = this.filterHistory.length
    for (let outputIndex = 0; outputIndex < input.length; outputIndex += 1) {
      let total = 0
      for (let tap = 0; tap < this.antiAliasKernel.length; tap += 1) total += source[outputIndex + tap] * this.antiAliasKernel[this.antiAliasKernel.length - 1 - tap]
      filtered[outputIndex] = total
    }
    this.filterHistory = source.slice(source.length - historyLength)
    return filtered
  }

  process(input: Float32Array): Float32Array {
    if (this.sourceRate === this.targetRate || input.length === 0) return input
    const filtered = this.filter(input)
    const samples = new Float32Array(this.tail.length + filtered.length)
    samples.set(this.tail); samples.set(filtered, this.tail.length)
    const ratio = this.sourceRate / this.targetRate
    const output: number[] = []
    while (this.cursor + 1 < samples.length) {
      const lower = Math.floor(this.cursor)
      const fraction = this.cursor - lower
      output.push(samples[lower] + (samples[lower + 1] - samples[lower]) * fraction)
      this.cursor += ratio
    }
    const retainedStart = Math.max(0, Math.floor(this.cursor) - 1)
    this.tail = samples.slice(retainedStart)
    this.cursor -= retainedStart
    return Float32Array.from(output)
  }
}

export const chooseModelSampleRate = (deviceRate: number, supported: number[]): number => {
  if (!supported.length || supported.includes(deviceRate)) return deviceRate
  const lower = supported.filter((rate) => rate <= deviceRate).sort((a, b) => b - a)[0]
  return lower ?? supported.slice().sort((a, b) => Math.abs(a - deviceRate) - Math.abs(b - deviceRate))[0]
}
