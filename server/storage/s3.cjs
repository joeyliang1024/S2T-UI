const { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { Readable } = require('node:stream')

// Preserve the storage adapter's small S3 contract without MinIO's vulnerable
// query-string/stream-json dependency chain. No credentials leave this client.
class S3CompatibleClient {
  constructor(options, { client, upload = Upload } = {}) {
    this.client = client || new S3Client({
      endpoint: `${options.useSSL ? 'https' : 'http'}://${options.endPoint}:${options.port}`,
      region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED'
    })
    this.Upload = upload
  }
  async bucketExists(Bucket) {
    try { await this.client.send(new HeadBucketCommand({ Bucket })); return true }
    catch (error) { if (error.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchBucket'].includes(error.name)) return false; throw error }
  }
  async makeBucket(Bucket) { await this.client.send(new CreateBucketCommand({ Bucket })) }
  async putObject(Bucket, Key, Body, size) {
    const params = { Bucket, Key, Body, ...(Number.isSafeInteger(size) && size >= 0 ? { ContentLength: size } : {}) }
    if (Body && typeof Body.pipe === 'function') {
      await new this.Upload({ client: this.client, params, partSize: 8 * 1024 * 1024, queueSize: 1, leavePartsOnError: false }).done()
    } else await this.client.send(new PutObjectCommand(params))
  }
  async getObject(Bucket, Key) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket, Key }))
      if (!result.Body || typeof result.Body[Symbol.asyncIterator] !== 'function') throw new Error('S3 returned an invalid object body')
      return result.Body
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(error.name)) { error.code = 'NoSuchKey' }
      throw error
    }
  }
  async removeObject(Bucket, Key) { await this.client.send(new DeleteObjectCommand({ Bucket, Key })) }
  listObjects(Bucket, Prefix) {
    const client = this.client
    return Readable.from((async function * () {
      let ContinuationToken
      const seen = new Set()
      do {
        const result = await client.send(new ListObjectsV2Command({ Bucket, Prefix, ...(ContinuationToken ? { ContinuationToken } : {}) }))
        for (const item of result.Contents || []) if (typeof item.Key === 'string') yield { name: item.Key }
        if (!result.IsTruncated) return
        const next = result.NextContinuationToken
        if (typeof next !== 'string' || !next || seen.has(next)) throw new Error('S3 returned an invalid continuation token')
        seen.add(next); ContinuationToken = next
      } while (true)
    })())
  }
  destroy() { this.client.destroy() }
}
module.exports = { S3CompatibleClient }
