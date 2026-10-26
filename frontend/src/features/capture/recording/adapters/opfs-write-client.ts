type Reply = { id: number; ready?: boolean; unsupported?: boolean; committed?: boolean; error?: string }
/** One request at a time, enforced by OpfsPcmRecording. No retry after an ambiguous write. */
export class OpfsWriteClient {
  private sequence = 0
  private failed = false
  private pending?: { id: number; resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  private constructor(private readonly worker: Worker, private readonly writeTimeoutMs = 30000) {
    worker.onmessage = (event: MessageEvent<Reply>) => {
      if (event.data.id !== this.pending?.id) return
      const pending = this.pending; this.pending = undefined
      clearTimeout(pending.timer)
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve(event.data)
    }
    worker.onerror = event => { event.preventDefault(); this.fail(new Error(event.message || 'Storage worker failed')) }
    worker.onmessageerror = () => this.fail(new Error('Storage worker message failed'))
  }
  static async create(): Promise<OpfsWriteClient | null> {
    if (typeof Worker === 'undefined') return null
    let client: OpfsWriteClient | undefined
    try {
      client = new OpfsWriteClient(new Worker(new URL('./opfs-write.worker.ts', import.meta.url), { type: 'module' }))
      // Initialization may fail under CSP or unsupported worker loading. Fall
      // back only here, before recording bytes have been submitted.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([client.request({}), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Storage worker startup timed out')), 3000) })])
      } finally { clearTimeout(timer) }
      return client
    } catch { client?.close(); return null }
  }
  private fail(error: Error): void {
    this.failed = true
    const pending = this.pending; this.pending = undefined
    if (pending) { clearTimeout(pending.timer); pending.reject(error) }
    this.worker.terminate()
  }
  private request(message: { file?: unknown; audio?: ArrayBuffer; commit?: unknown }): Promise<Reply> {
    if (this.failed) return Promise.reject(new Error('Storage worker is closed'))
    if (this.pending) return Promise.reject(new Error('Concurrent storage worker write'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new DOMException('Storage worker write timed out; committed audio retained', 'TimeoutError')), this.writeTimeoutMs)
      this.pending = { id, resolve, reject, timer }
      try { this.worker.postMessage({ id, ...message }) }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  async write(file: unknown, audio: ArrayBuffer, commit: unknown): Promise<boolean> {
    const reply = await this.request({ file, audio, commit })
    if (reply.unsupported) return false
    if (!reply.committed) throw new Error('Storage worker did not confirm commit')
    return true
  }
  close(): void { this.fail(new Error('Storage worker is closed')) }
}
