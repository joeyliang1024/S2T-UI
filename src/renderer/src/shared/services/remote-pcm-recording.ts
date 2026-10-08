import { retryableAuthFetch } from '../../features/auth/services/auth-client'

const check = async (response: Response): Promise<Response> => {
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) }
  return response
}
// BufferedPcmWriter supplies serial writes and bounded backpressure. The index
// advances only after a durable ACK, so retrying a write sends the same bytes.
export class RemotePcmRecording {
  private index = 0
  private samples = 0
  constructor(readonly id: string, readonly sampleRate: number) {}
  async append(audio: ArrayBuffer): Promise<void> {
    for (let offset = 0; offset < audio.byteLength; offset += 1024 * 1024) {
      const chunk = audio.slice(offset, Math.min(audio.byteLength, offset + 1024 * 1024))
      const response = await check(await retryableAuthFetch(`/api/data/recordings/${encodeURIComponent(this.id)}/chunks/${this.index}`, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-s2t-start-sample': String(this.samples), 'x-s2t-sample-rate': String(this.sampleRate) }, body: chunk
      }))
      const ack = await response.json() as { durable?: boolean; contiguousChunks?: number; persistedSamples?: number }
      if (!ack.durable || ack.contiguousChunks !== this.index + 1 || ack.persistedSamples !== this.samples + chunk.byteLength / 2) throw new Error('錄音保存進度不一致')
      this.index += 1; this.samples += chunk.byteLength / 2
    }
  }
  async finish(): Promise<void> {
    if (!this.index) return
    await check(await retryableAuthFetch(`/api/data/recordings/${encodeURIComponent(this.id)}/finish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totalChunks: this.index, totalSamples: this.samples })
    }))
  }
  async promote(audioKey: string): Promise<void> { await check(await retryableAuthFetch(`/api/data/recordings/${encodeURIComponent(this.id)}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audioKey }) })) }
  async discardCompleted(): Promise<void> { await check(await retryableAuthFetch(`/api/data/recordings/${encodeURIComponent(this.id)}`, { method: 'DELETE' })) }
  static async recover(id: string): Promise<Blob | undefined> {
    const status = await retryableAuthFetch(`/api/data/recordings/${encodeURIComponent(id)}`)
    if (status.status === 404) return undefined
    await check(status)
    const progress = await status.json() as { contiguousChunks: number; persistedSamples: number }
    if (!progress.contiguousChunks) return undefined
    await check(await retryableAuthFetch(`/api/data/recordings/${encodeURIComponent(id)}/finish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ totalChunks: progress.contiguousChunks, totalSamples: progress.persistedSamples })
    }))
    const response = await check(await retryableAuthFetch(`/api/data/audio/${encodeURIComponent(id)}`))
    return response.blob()
  }
}
