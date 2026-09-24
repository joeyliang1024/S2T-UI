

export const dbfs = (value: number): number => (value > 0 ? Math.max(-60, 20 * Math.log10(value)) : -60)

export const dbfsLabel = (value: number): string => `${value.toFixed(0)} dBFS`

export const meterPercent = (value: number): number => Math.max(0, Math.min(100, ((value + 60) / 60) * 100))

export const makeWav = (chunks: Float32Array[], sampleRate: number): Blob => {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + sampleCount * bytesPerSample)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * bytesPerSample, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * bytesPerSample, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const normalized = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
      offset += bytesPerSample
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export const pcm16 = (samples: Float32Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  samples.forEach((sample, index) => {
    const normalized = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * 2, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
  })
  return buffer
}

export class BufferedPcmWriter {
  private pending: ArrayBuffer[] = []
  private pendingBytes = 0
  private writing = false
  private closed = false
  private pressured = false
  private failure: Error | null = null
  private timer: number | null = null
  private idleWaiters: Array<() => void> = []

  constructor(
    private readonly append: (audio: ArrayBuffer) => Promise<unknown>,
    private readonly onPressure: (active: boolean) => void,
    private readonly onFailure: (error: Error) => void,
    private readonly batchBytes = 24_000,
    private readonly maximumPendingBytes = 192_000
  ) {}

  push(audio: ArrayBuffer): void {
    if (this.closed || this.failure) return
    this.pending.push(audio)
    this.pendingBytes += audio.byteLength
    if (this.pendingBytes >= this.maximumPendingBytes && !this.pressured) {
      this.pressured = true
      this.onPressure(true)
    }
    if (this.pendingBytes >= this.batchBytes) this.pump()
    else if (this.timer === null) this.timer = window.setTimeout(() => {
      this.timer = null
      this.pump()
    }, 125)
  }

  async closeAndDrain(): Promise<void> {
    this.closed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.pump()
    if (this.writing || this.pendingBytes) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    if (this.failure) throw this.failure
  }

  discard(): void {
    this.closed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.pending = []
    this.pendingBytes = 0
    this.resolveIdle()
  }

  private pump(): void {
    if (this.writing || this.failure || !this.pendingBytes || (!this.closed && this.pendingBytes < this.batchBytes)) return
    const pieces: ArrayBuffer[] = []
    let bytes = 0
    while (this.pending.length && (bytes < this.batchBytes || !pieces.length)) {
      const piece = this.pending.shift()!
      pieces.push(piece)
      bytes += piece.byteLength
    }
    this.pendingBytes -= bytes
    const merged = new Uint8Array(bytes)
    let offset = 0
    for (const piece of pieces) { merged.set(new Uint8Array(piece), offset); offset += piece.byteLength }
    this.writing = true
    void this.append(merged.buffer).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error('錄音暫存檔寫入失敗')
      this.pending = []
      this.pendingBytes = 0
      this.onFailure(this.failure)
    }).finally(() => {
      this.writing = false
      if (!this.closed && this.pressured && this.pendingBytes <= this.batchBytes) {
        this.pressured = false
        this.onPressure(false)
      }
      if (this.pendingBytes && !this.failure) this.pump()
      else if (!this.writing && !this.pendingBytes) this.resolveIdle()
    })
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters.splice(0)
    waiters.forEach((resolve) => resolve())
  }
}
