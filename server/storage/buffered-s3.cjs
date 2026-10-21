const { S3CompatibleClient } = require('./s3.cjs')
const { createBlobWriter } = require('./blob-writer.cjs')

// One bounded worker per storage adapter; shared by every user's small immutable
// recording PUT. Keep streams/reads on a separate control pool. Combined socket
// ceiling is 16 + 112 = 128, independent of users and HTTP request concurrency.
class BufferedS3Client extends S3CompatibleClient {
  constructor(options) {
    super({ ...options, maxConnections: 16 })
    this.writer = createBlobWriter({ ...options, maxConnections: 112, initialConnections: 112, idleConnections: 64 })
    const control = this.stats
    this.stats = () => {
      const left = control(), right = this.writer.stats()
      const sum = {}
      for (const key of new Set([...Object.keys(left),...Object.keys(right)])) sum[key] = (left[key] || 0) + (right[key] || 0)
      return sum
    }
  }
  putObject(bucket, key, body, size) {
    if (Buffer.isBuffer(body) && body.length <= 1024 ** 2) return this.writer.put(bucket, key, body)
    return super.putObject(bucket, key, body, size)
  }
  destroy() { this.writer.close(); super.destroy() }
}
module.exports = { BufferedS3Client }
