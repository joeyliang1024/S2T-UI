const { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { Readable } = require('node:stream')
const { Agent: HttpAgent } = require('node:http')
const { Agent: HttpsAgent } = require('node:https')
const { cachedLookup } = require('../dns-lookup.cjs')
const { createAdaptiveCapacity } = require('../adaptive-capacity.cjs')

// Preserve the storage adapter's small S3 contract without MinIO's vulnerable
// query-string/stream-json dependency chain. No credentials leave this client.
class S3CompatibleClient {
  constructor(options, { client, upload = Upload } = {}) {
    const maximum = options.maxConnections ?? 128
    if (!Number.isSafeInteger(maximum) || maximum < 4 || maximum > 128) throw new Error('Invalid S3 connection budget')
    const initial = options.initialConnections ?? Math.min(32, maximum)
    if (!Number.isSafeInteger(initial) || initial < 4 || initial > maximum) throw new Error('Invalid initial S3 connection budget')
    const idleFloor = Math.min(options.idleConnections ?? 16, maximum)
    if (!Number.isSafeInteger(idleFloor) || idleFloor < 4) throw new Error('Invalid idle S3 connection budget')
    const httpAgent = new HttpAgent({ lookup: cachedLookup, keepAlive: true, maxSockets: initial, maxFreeSockets: initial })
    const httpsAgent = new HttpsAgent({ lookup: cachedLookup, keepAlive: true, maxSockets: initial, maxFreeSockets: initial })
    this.capacity = createAdaptiveCapacity({ minimum: 4, maximum, initial, idleFloor, growthMs: 250, healthyMs: 1000, waitMs: 30000,
      onLimit: limit => {
        for (const agent of [httpAgent, httpsAgent]) {
          agent.maxSockets = limit; agent.maxFreeSockets = limit
          // Only retire idle sockets. In-flight uploads retain their socket.
          for (const sockets of Object.values(agent.freeSockets)) for (const socket of sockets.slice(agent.maxFreeSockets)) socket.destroy()
        }
      }
    })
    this.stats = () => ({ ...this.capacity.stats(), sockets: [httpAgent, httpsAgent].reduce((sum, agent) => sum + Object.values(agent.sockets).reduce((n, sockets) => n + sockets.length, 0), 0), idleSockets: [httpAgent, httpsAgent].reduce((sum, agent) => sum + Object.values(agent.freeSockets).reduce((n, sockets) => n + sockets.length, 0), 0) })
    this.client = client || new S3Client({
      endpoint: `${options.useSSL ? 'https' : 'http'}://${options.endPoint}:${options.port}`,
      region: 'us-east-1', forcePathStyle: true,
      // Bound both dead sockets and the SDK's internal socket-acquisition queue.
      // Keep multipart queueSize=1 below: 500 uploads must not each allocate
      // four simultaneous 8 MiB parts.
      requestHandler: {
        connectionTimeout: 3000, socketTimeout: 15000,
        requestTimeout: 120000, throwOnRequestTimeout: true,
        httpAgent, httpsAgent
      },
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED'
    })
    if (!client) this.client.middlewareStack.add(next => async args => {
      const release = await this.capacity.acquire()
      try { const result = await next(args); release(); return result }
      catch (error) { release(error); throw error }
    }, { step: 'initialize', name: 'adaptiveS3Capacity' })
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
  async copyObject(Bucket, sourceKey, Key) { await this.client.send(new CopyObjectCommand({ Bucket, Key, CopySource: `${encodeURIComponent(Bucket)}/${sourceKey.split('/').map(encodeURIComponent).join('/')}` })) }
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
  destroy() { this.capacity.close(); this.client.destroy() }
}
module.exports = { S3CompatibleClient }
