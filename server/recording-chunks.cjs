const { createHash } = require('node:crypto')
const { Readable } = require('node:stream')
const fault = (message, status = 400) => Object.assign(new Error(message), { status })
const MAX_PCM_BYTES = 2 * 1024 ** 3 - 44
const wavHeader = (bytes, rate) => {
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(bytes, 40)
  return header
}
class RecordingChunks {
  constructor(storage) { this.storage = storage }
  key(id) { if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw fault('無效的錄音 ID'); return `recording-${id}` }
  async status(userId, id) { return this.storage.config.get(userId, this.key(id)) }
  async append(userId, id, index, startSample, sampleRate, audio) {
    const key = this.key(id)
    if (!Number.isSafeInteger(index) || index < 0 || index >= 100000 || !Number.isSafeInteger(startSample) || startSample < 0 || !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !audio.length || audio.length > 1024 ** 2 || audio.length % 2 || (startSample * 2 + audio.length) > MAX_PCM_BYTES) throw fault('無效的 PCM chunk')
    const digest = createHash('sha256').update(audio).digest('hex')
    const blobKey = `chunks/${id}/${index}-${digest}`
    // Write immutable bytes before acknowledging metadata. Failed writes cannot advance ACK.
    await this.storage.blob.put(userId, blobKey, audio)
    let result
    await this.storage.config.update(userId, key, value => {
      const manifest = value || { sampleRate, chunks: {}, contiguousChunks: 0, persistedSamples: 0, state: 'recording' }
      if (manifest.sampleRate !== sampleRate) throw fault('錄音取樣率不同', 409)
      const existing = manifest.chunks[index]
      if (existing) {
        if (existing.digest !== digest || existing.startSample !== startSample) throw fault('相同序號的音訊內容不同', 409)
        result = manifest; return undefined
      }
      if (manifest.state !== 'recording') throw fault('錄音已停止', 409)
      const samples = audio.length / 2
      for (const chunk of Object.values(manifest.chunks)) if (startSample < chunk.startSample + chunk.samples && startSample + samples > chunk.startSample) throw fault('音訊 sample 範圍重疊', 409)
      manifest.chunks[index] = { digest, blobKey, startSample, samples }
      while (manifest.chunks[manifest.contiguousChunks]?.startSample === manifest.persistedSamples) {
        manifest.persistedSamples += manifest.chunks[manifest.contiguousChunks].samples
        manifest.contiguousChunks += 1
      }
      manifest.updatedAt = new Date().toISOString(); result = manifest
      return manifest
    })
    return { durable: true, contiguousChunks: result.contiguousChunks, persistedSamples: result.persistedSamples }
  }
  async removeCompleted(userId, id) {
    const key = this.key(id)
    let manifest
    await this.storage.config.update(userId, key, value => {
      if (!value) return undefined
      if (!['completed', 'deleting'].includes(value.state)) throw fault('只能清理已完成的錄音備份', 409)
      manifest = value
      return { ...value, state: 'deleting' }
    })
    if (!manifest) return
    // A retry resumes deletion; never discard an unfinished acknowledged recording.
    for (const chunk of Object.values(manifest.chunks)) await this.storage.blob.remove(userId, chunk.blobKey)
    await this.storage.blob.remove(userId, `audio/${id}`)
    await this.storage.config.remove(userId, key)
  }
  async finish(userId, id, totalChunks, totalSamples) {
    const key = this.key(id)
    if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || !Number.isSafeInteger(totalSamples) || totalSamples < 1) throw fault('無效的停止進度')
    let manifest
    await this.storage.config.update(userId, key, value => {
      if (value?.state === 'deleting') throw fault('錄音正在清理', 409)
      if (!value || value.contiguousChunks !== totalChunks || value.persistedSamples !== totalSamples || Object.keys(value.chunks).length !== totalChunks) throw fault('音訊尚未完整保存', 409)
      manifest = { ...value, state: 'finishing' }
      if (value.state === 'completed') { manifest = value; return undefined }
      return manifest
    })
    if (manifest.state !== 'completed') {
      const store = this.storage.blob
      const bytes = totalSamples * 2
      const stream = Readable.from((async function* () {
        yield wavHeader(bytes, manifest.sampleRate)
        for (let index = 0; index < totalChunks; index++) {
          const chunk = manifest.chunks[index]
          const audio = await store.get(userId, chunk.blobKey)
          if (!audio || audio.length !== chunk.samples * 2 || createHash('sha256').update(audio).digest('hex') !== chunk.digest) throw fault('持久化音訊驗證失敗', 503)
          yield audio
        }
      })())
      await store.putStream(userId, `audio/${id}`, stream, bytes + 44)
      await this.storage.config.update(userId, key, value => ({ ...value, state: 'completed', audioKey: id, updatedAt: new Date().toISOString() }))
    }
    return { durable: true, audioKey: id, persistedSamples: totalSamples, contiguousChunks: totalChunks }
  }
}
module.exports = { RecordingChunks, wavHeader }
