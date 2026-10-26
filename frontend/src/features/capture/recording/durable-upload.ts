import { requestEpoch } from '../../../shared/http/authenticated-client'

type Source = { readonly persistedSamples: number; readCommittedAudio: (startSample: number, maximumSamples: number) => Promise<ArrayBuffer> }
type Destination = { readonly persistedSamples: number; append: (audio: ArrayBuffer, signal?: AbortSignal) => Promise<void>; finish: (signal?: AbortSignal) => Promise<void> }
/** The durable OPFS spool is the queue; reads are capped at 1 MiB regardless of backlog. */
export class DurableRecordingUpload {
  private readonly owner = requestEpoch()
  private readonly controller = new AbortController()
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private failures = 0
  private waiting = false
  private terminalError: unknown
  private pendingRange: { start: number; bytes: ArrayBuffer } | null = null
  constructor(private readonly source: Source, private readonly destination: Destination, private readonly onWaiting: (waiting: boolean, error?: unknown) => void = () => {}, private readonly finishTimeoutMs = 30000, private readonly batch?: { minimumBytes: number; maximumDelayMs: number }) {}
  private checkOwner(): void {
    if (this.owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError')
  }
  private state(waiting: boolean, error?: unknown): void {
    if (this.waiting === waiting && !error) return
    this.waiting = waiting
    this.onWaiting(waiting, error)
  }
  notify(force = false): void {
    if (this.closed || this.running || this.timer || this.terminalError) return
    const available = (this.source.persistedSamples - this.destination.persistedSamples) * 2
    if (!available && !this.pendingRange) return
    if (!force && !this.pendingRange && this.batch && available < this.batch.minimumBytes) {
      if (!this.batchTimer) this.batchTimer = setTimeout(() => { this.batchTimer = undefined; this.notify(true) }, this.batch.maximumDelayMs * (0.5 + Math.random() * 0.5))
      return
    }
    clearTimeout(this.batchTimer); this.batchTimer = undefined
    const operation = this.drain(force).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') this.terminalError = error
      else if (this.owner !== requestEpoch()) this.terminalError = new DOMException('Account changed', 'AbortError')
      const status = (error as { status?: number } | null)?.status
      if (typeof status === 'number' && status < 500 && ![408, 425, 429].includes(status)) this.terminalError = error
      this.state(true, this.terminalError)
      if (!this.closed && !this.terminalError) {
        const delay = Math.min(15000, 500 * 2 ** Math.min(this.failures++, 5) * (0.75 + Math.random() * 0.5))
        this.timer = setTimeout(() => { this.timer = undefined; this.notify() }, delay)
      }
    }).finally(() => {
      if (this.running === operation) this.running = null
      if (!this.closed && !this.timer && !this.terminalError && this.destination.persistedSamples < this.source.persistedSamples) this.notify()
    })
    this.running = operation
  }
  private async drain(force = false): Promise<void> {
    while (!this.closed && this.destination.persistedSamples < this.source.persistedSamples) {
      this.checkOwner()
      if (!force && !this.pendingRange && this.batch && (this.source.persistedSamples - this.destination.persistedSamples) * 2 < this.batch.minimumBytes) break
      const start = this.destination.persistedSamples
      // Keep the exact failed range while new audio continues to commit.
      // Rereading a larger available tail after a lost ACK would reuse the
      // same chunk index with different bytes and correctly trigger a conflict.
      const range = this.pendingRange?.start === start ? this.pendingRange : { start, bytes: await this.source.readCommittedAudio(start, 512 * 1024) }
      this.pendingRange = range
      const bytes = range.bytes
      this.checkOwner()
      if (!bytes.byteLength || bytes.byteLength > 1024 * 1024 || bytes.byteLength % 2) throw new Error('Invalid committed upload range')
      await this.destination.append(bytes, this.controller.signal)
      if (this.destination.persistedSamples !== start + bytes.byteLength / 2) throw new Error('Upload did not acknowledge the committed range')
      this.pendingRange = null
    }
    if (this.destination.persistedSamples === this.source.persistedSamples) { this.failures = 0; this.state(false) }
  }
  /** Stop background retries; stopping offline must return local recovery audio. */
  async finish(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    clearTimeout(this.batchTimer); this.batchTimer = undefined
    this.closed = true
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; this.controller.abort() }, this.finishTimeoutMs)
    try {
      await this.running?.catch(() => undefined)
      if (this.terminalError) throw this.terminalError
      this.checkOwner()
      this.closed = false
      await this.drain(true)
      this.checkOwner()
      await this.destination.finish(this.controller.signal)
    } catch (error) {
      this.checkOwner()
      if (timedOut) throw new DOMException('Upload finalization timed out; local audio retained', 'TimeoutError')
      throw error
    } finally { this.closed = true; clearTimeout(deadline) }
  }
  async abort(): Promise<void> {
    this.closed = true
    this.controller.abort()
    clearTimeout(this.timer); this.timer = undefined
    clearTimeout(this.batchTimer); this.batchTimer = undefined
    await this.running?.catch(() => undefined)
    this.pendingRange = null
  }
}
