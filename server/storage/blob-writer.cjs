const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const { createConcurrencyGate } = require('../concurrency-gate.cjs')

if (!isMainThread && workerData?.s2tBlobWriter) {
  const { S3CompatibleClient } = require('./s3.cjs')
  const client = new S3CompatibleClient(workerData.options)
  const publishStats = () => parentPort.postMessage({ type: 'stats', value: client.stats() })
  const timer = setInterval(publishStats, 250); timer.unref()
  parentPort.on('message', async message => {
    if (message.type !== 'put') return
    try {
      const bytes = Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength)
      await client.putObject(message.bucket, message.key, bytes, bytes.length)
      parentPort.postMessage({ type: 'result', id: message.id })
    } catch (error) {
      parentPort.postMessage({ type: 'result', id: message.id, error: { message: error.message, code: error.code, name: error.name, status: error.$metadata?.httpStatusCode } })
    } finally { publishStats() }
  })
  publishStats()
}

const createBlobWriter = options => {
  let worker, closed = false, sequence = 0, bytesPending = 0
  let snapshot = { limit: Math.min(32,options.maxConnections), maximum: options.maxConnections, active: 0, waiting: 0, sockets: 0, idleSockets: 0 }
  const pending = new Map()
  const gate = createConcurrencyGate({ maximum: options.maxConnections, maxWaiting: 512, waitMs: 10000 })
  const unavailable = message => Object.assign(new Error(message), { status: 503 })
  const fail = (target, error) => {
    if (worker !== target) return
    worker = null
    snapshot = { ...snapshot, active: 0, waiting: 0, sockets: 0, idleSockets: 0 }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    pending.clear()
    void target.terminate()
  }
  const start = () => {
    if (worker) return worker
    if (closed) throw unavailable('Blob writer closed')
    const target = worker = new Worker(__filename, { workerData: { s2tBlobWriter: true, options } })
    target.on('message', message => {
      if (worker !== target) return
      if (message.type === 'stats') { snapshot = message.value; return }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id); clearTimeout(entry.timer)
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code, name: message.error.name, $metadata: { httpStatusCode: message.error.status } }))
      else entry.resolve()
      if (!pending.size) target.unref()
    })
    target.on('error', error => fail(target, error))
    target.on('exit', code => fail(target, unavailable(`Blob writer exited (${code})`)))
    target.unref()
    return target
  }
  start()
  return {
    stats: () => ({ ...snapshot, waiting: snapshot.waiting + gate.stats().waiting, bufferedPending: pending.size, bufferedBytes: bytesPending }),
    async put(bucket, key, body) {
      // Bound queued + active payload bytes independently of request count.
      if (closed || bytesPending + body.length > 64 * 1024 ** 2) throw unavailable('Blob writer byte budget exhausted')
      bytesPending += body.length
      try {
        return await gate(() => new Promise((resolve, reject) => {
          if (closed) return reject(unavailable('Blob writer closed'))
          const target = start(), id = ++sequence
          const timer = setTimeout(() => fail(target, unavailable('Blob writer deadline exceeded')), 15000)
          pending.set(id, { resolve, reject, timer }); target.ref()
          try {
            // Transfer an owned copy; callers retain their original audio for
            // retries/digests. Never detach a pooled Node Buffer's backing store.
            const bytes = Uint8Array.from(body)
            target.postMessage({ type: 'put', id, bucket, key, bytes }, [bytes.buffer])
          } catch (error) { pending.delete(id); clearTimeout(timer); if (!pending.size) target.unref(); reject(error) }
        }))
      } finally { bytesPending -= body.length }
    },
    close() {
      closed = true
      if (worker) fail(worker, unavailable('Blob writer closed'))
    }
  }
}
module.exports = { createBlobWriter }
