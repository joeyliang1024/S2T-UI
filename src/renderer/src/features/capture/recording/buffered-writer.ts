import { activeTranslate } from '../../../shared/i18n'

/** PCM16 mono limits expressed in capture time, independent of device sample rate. */
export const pcmRecordingBufferLimits = (sampleRate: number, remote = false): { batchBytes: number; maximumPendingBytes: number } => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid recording sample rate')
  const bytesPerSecond = Math.ceil(sampleRate) * 2
  return { batchBytes: bytesPerSecond * (remote ? 2 : .5), maximumPendingBytes: bytesPerSecond * 8 }
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
    // Drain the accepted backlog in one bounded write. Replaying many small
    // writes after a stall otherwise spends extra time on per-write overhead.
    const pieces = this.pending
    const bytes = this.pendingBytes
    this.pending = []
    this.pendingBytes = 0
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    const merged = new Uint8Array(bytes)
    let offset = 0
    for (const piece of pieces) { merged.set(new Uint8Array(piece), offset); offset += piece.byteLength }
    this.writing = true
    void this.append(merged.buffer).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(activeTranslate('svcAudioWriteFailed'))
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
