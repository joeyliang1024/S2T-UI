const { Worker } = require('node:worker_threads')
const { join } = require('node:path')
const { modelPaths } = require('./sherpa-diarization.cjs')

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
const positiveNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Duration of the payload in seconds. The RIFF header is authoritative;
 * otherwise assume PCM16 @16 kHz mono (32 000 B/s), which is what this
 * gateway accepts. Used only to size a timeout, never to bill or slice.
 */
const estimateAudioSec = (payload) => {
  const audio = payload?.audio
  if (!audio || typeof audio.byteLength !== 'number' || audio.byteLength < 44) return 0
  try {
    if (typeof audio.readUInt16LE === 'function' && audio.toString('latin1', 0, 4) === 'RIFF' && audio.toString('latin1', 8, 16) === 'WAVEfmt ') {
      const channels = Math.max(1, audio.readUInt16LE(22))
      const sampleRate = audio.readUInt32LE(24)
      const bits = audio.readUInt16LE(34) || 16
      if (sampleRate >= 1_000 && sampleRate <= 384_000 && bits >= 8 && bits <= 64) {
        return audio.byteLength / (sampleRate * channels * (bits / 8))
      }
    }
  } catch { /* fall through to the conservative estimate */ }
  return audio.byteLength / 32_000
}

/**
 * Two pools instead of one. A 40 minute diarization job must not sit in front
 * of the Silero call that answers a settings page, and a queued enrollment
 * must not wait for a meeting transcription to finish.
 *
 * The initial production default is deliberately one CPU-heavy job per pod.
 * Operators scale dedicated audio-worker pods before increasing this value.
 */
class SherpaWorkerPool {
  constructor ({
    label = 'sherpa',
    size = positiveInteger(process.env.S2T_SHERPA_WORKERS, 1),
    maxQueue = positiveInteger(process.env.S2T_SHERPA_MAX_QUEUE, 8),
    // Cap for the length-scaled timeout below.
    capTimeoutMs = positiveInteger(process.env.S2T_SHERPA_JOB_TIMEOUT_MS, 1_800_000),
    baseTimeoutMs = positiveNumber(process.env.S2T_SHERPA_JOB_TIMEOUT_BASE_MS, 60_000),
    timeoutPerAudioSec = positiveNumber(process.env.S2T_SHERPA_JOB_TIMEOUT_PER_AUDIO_SEC, 400)
  } = {}) {
    this.label = label
    this.size = size
    this.maxQueue = maxQueue
    this.capTimeoutMs = capTimeoutMs
    this.baseTimeoutMs = baseTimeoutMs
    this.timeoutPerAudioSec = timeoutPerAudioSec
    this.workers = []
    this.queue = []
    this.jobs = new Map()
    // Per-operation execution statistics: the only way to decide whether a
    // CPU budget claim is true. Wall time in the worker, queue wait excluded.
    this.opStats = new Map()
    this.nextId = 1
    this.nextAudioId = 1
    // Buffer identity → the id under which the worker retained it.
    this.audioIdsByBuffer = new WeakMap()
    this.closed = false
  }

  recordStat (job, meta) {
    if (!job.startedAt) return
    const elapsed = Date.now() - job.startedAt
    const current = this.opStats.get(job.operation) || { count: 0, totalMs: 0, maxMs: 0, audioSec: 0, audioBytes: 0, transferredBytes: 0 }
    current.count += 1
    current.totalMs += elapsed
    current.maxMs = Math.max(current.maxMs, elapsed)
    current.audioBytes += job.audioBytes || 0
    current.transferredBytes += job.transferredBytes || 0
    if (Number.isFinite(meta?.durationMs)) current.audioSec += meta.durationMs / 1000
    this.opStats.set(job.operation, current)
  }

  start () {
    while (!this.closed && this.workers.length < this.size) this.spawn()
  }

  spawn () {
    const entry = { worker: new Worker(join(__dirname, 'sherpa-worker.cjs')), busy: false, unavailable: false, jobId: null, intentionalExit: false, audioIds: new Map() }
    entry.worker.on('message', (message) => this.complete(entry, message))
    entry.worker.on('error', (error) => this.failWorker(entry, error))
    entry.worker.on('exit', (code) => {
      if (!entry.intentionalExit && code !== 0) this.failWorker(entry, new Error(`sherpa worker 非正常結束（code ${code}）`))
      this.workers = this.workers.filter((item) => item !== entry)
      if (!this.closed) { this.start(); this.dispatch() }
    })
    this.workers.push(entry)
  }

  /**
   * `retainAudio` pins the payload's audio inside the worker for the lifetime
   * of its cache entry, so the second call of the same request (diarize, then
   * label) does not clone the whole recording across the thread boundary a
   * second time.
   */
  execute (operation, payload, { priority = 'background', timeoutMs, signal, retainAudio = false } = {}) {
    if (this.closed) return Promise.reject(new Error('sherpa worker pool 已關閉'))
    if (signal?.aborted) return Promise.reject(new Error('sherpa 工作已取消'))
    if (this.workers.length && this.workers.every((entry) => entry.unavailable)) return Promise.reject(new Error('語者 worker 正在恢復逾時工作，暫時無法接受新工作'))
    if (this.queue.length + this.jobs.size >= this.maxQueue) return Promise.reject(new Error('語者處理佇列已滿，請稍後再試'))
    this.start()
    return new Promise((resolve, reject) => {
      // The id must be stable for one recording, otherwise the worker cache
      // can never be hit by the second call of the same request. Keying by
      // the Buffer identity gives that stability and lets the id disappear
      // with the recording itself.
      let audioId
      if (retainAudio && payload?.audio) {
        audioId = this.audioIdsByBuffer.get(payload.audio)
        if (!audioId) {
          audioId = `${this.label}-a${this.nextAudioId++}`
          this.audioIdsByBuffer.set(payload.audio, audioId)
        }
      }
      const jobPayload = audioId ? { ...payload, audioId } : payload
      const job = {
        id: this.nextId++,
        operation,
        payload: jobPayload,
        audioId,
        audioBytes: jobPayload?.audio?.byteLength || 0,
        transferredBytes: jobPayload?.audio?.byteLength || 0,
        timeoutMs: this.timeoutFor(jobPayload, timeoutMs),
        resolve,
        reject,
        signal
      }
      job.cancel = () => {
        const queuedAt = this.queue.indexOf(job)
        if (queuedAt !== -1) { this.queue.splice(queuedAt, 1); reject(new Error('sherpa 工作已取消')); return }
        if (!this.jobs.has(job.id)) return
        const entry = this.workers.find((item) => item.jobId === job.id)
        this.finishJob(job, new Error('sherpa 工作已取消'))
        if (entry) entry.unavailable = true
      }
      signal?.addEventListener('abort', job.cancel, { once: true })
      if (priority === 'interactive') {
        const firstBackground = this.queue.findIndex((item) => item.priority !== 'interactive')
        job.priority = priority
        if (firstBackground === -1) this.queue.push(job); else this.queue.splice(firstBackground, 0, job)
      } else { job.priority = priority; this.queue.push(job) }
      this.dispatch()
    })
  }

  // A fixed 120 s budget is wrong at both ends: too short for a long meeting,
  // far too long for a 2 s VAD call. Scale it with the input instead.
  timeoutFor (payload, explicit) {
    if (Number.isFinite(explicit)) return explicit
    const seconds = estimateAudioSec(payload)
    return Math.max(this.baseTimeoutMs, Math.min(this.capTimeoutMs, this.baseTimeoutMs + seconds * this.timeoutPerAudioSec))
  }

  /** Strip audio the target worker already holds; keep it otherwise. */
  payloadFor (entry, job) {
    if (!job.audioId) return job.payload
    if (job.forceAudio || !entry.audioIds.has(job.audioId)) {
      entry.audioIds.set(job.audioId, Date.now())
      job.transferredBytes = job.audioBytes
      return job.payload
    }
    entry.audioIds.set(job.audioId, Date.now())
    job.transferredBytes = 0
    const { audio, ...rest } = job.payload
    void audio
    return rest
  }

  dispatch () {
    for (const entry of this.workers) {
      if (entry.busy || entry.unavailable || !this.queue.length) continue
      const job = this.queue.shift()
      entry.busy = true; entry.jobId = job.id
      job.startedAt = Date.now()
      job.timer = setTimeout(() => {
        if (!this.jobs.has(job.id)) return
        this.finishJob(job, new Error(`sherpa ${job.operation} 逾時`))
        // sherpa native calls are synchronous. Terminating their thread can
        // abort the whole Node process, so quarantine it until it returns.
        entry.unavailable = true
      }, job.timeoutMs)
      this.jobs.set(job.id, job)
      try { entry.worker.postMessage({ id: job.id, operation: job.operation, payload: this.payloadFor(entry, job) }) } catch (error) { this.finishJob(job, error); entry.busy = false; entry.jobId = null }
    }
  }

  complete (entry, message) {
    const job = this.jobs.get(message?.id)
    if (!job) {
      // A cancelled/timed-out native call eventually returned. It is now safe
      // to put this worker back in service; no work ran concurrently with it.
      if (entry.jobId === message?.id) { entry.busy = false; entry.unavailable = false; entry.jobId = null; this.dispatch() }
      return
    }
    entry.busy = false; entry.jobId = null
    const error = message.error ? Object.assign(new Error(message.error.message), { stack: message.error.stack, code: message.error.code }) : null
    // The worker evicted a retained recording under memory pressure. Re-send
    // it once instead of failing the whole request.
    if (error?.code === 'AUDIO_MISSING' && job.audioId && !job.retried) {
      job.retried = true
      job.forceAudio = true
      job.startedAt = 0
      entry.audioIds.delete(job.audioId)
      clearTimeout(job.timer)
      this.queue.unshift(job)
      this.dispatch()
      return
    }
    this.finishJob(job, error, message.value, message.meta)
    this.dispatch()
  }

  finishJob (job, error, value, meta) {
    if (!this.jobs.delete(job.id)) return
    clearTimeout(job.timer)
    job.signal?.removeEventListener('abort', job.cancel)
    this.recordStat(job, meta)
    if (error) job.reject(error); else job.resolve(value)
  }

  failWorker (entry, error) {
    if (entry.jobId) {
      const job = this.jobs.get(entry.jobId)
      if (job) this.finishJob(job, error)
      entry.busy = false; entry.jobId = null
    }
  }

  async close () {
    this.closed = true
    for (const job of this.queue.splice(0)) job.reject(new Error('sherpa worker pool 已關閉'))
    for (const job of this.jobs.values()) this.finishJob(job, new Error('sherpa worker pool 已關閉'))
    await Promise.all(this.workers.map(async (entry) => { entry.intentionalExit = true; await entry.worker.terminate() }))
    this.workers = []
  }

  stats () {
    const ops = {}
    for (const [operation, value] of this.opStats) {
      ops[operation] = {
        count: value.count,
        totalMs: value.totalMs,
        maxMs: value.maxMs,
        avgMs: value.count ? Math.round(value.totalMs / value.count) : 0,
        audioSec: Math.round(value.audioSec * 10) / 10,
        audioBytes: value.audioBytes,
        transferredBytes: value.transferredBytes,
        audioMB: Math.round(value.audioBytes / 1_048_576),
        // Bytes that actually crossed the worker boundary: what retaining the
        // audio inside the worker saved is audioBytes - transferredBytes.
        transferredMB: Math.round(value.transferredBytes / 1_048_576),
        // Real-time factor of the work actually executed (queue wait excluded).
        rtf: value.audioSec > 0 ? Math.round(value.totalMs / (value.audioSec * 1_000) * 1_000) / 1_000 : null
      }
    }
    return { pool: this.label, configured: this.size, workers: this.workers.length, busy: this.workers.filter((item) => item.busy).length, queued: this.queue.length, inFlight: this.jobs.size, maxQueue: this.maxQueue, ops }
  }

  resetStats () { this.opStats.clear() }
}

// Interactive: settings, enrollment and VAD answers must never queue behind a
// meeting-sized job.
const interactivePool = new SherpaWorkerPool({
  label: 'interactive',
  size: positiveInteger(process.env.S2T_SHERPA_FAST_WORKERS, 1),
  maxQueue: positiveInteger(process.env.S2T_SHERPA_FAST_MAX_QUEUE, 8),
  capTimeoutMs: positiveInteger(process.env.S2T_SHERPA_FAST_JOB_TIMEOUT_MS, 120_000)
})
// Heavy: diarization and per-speaker embeddings.
const heavyPool = new SherpaWorkerPool({ label: 'heavy' })

const interactive = (operation, payload) => interactivePool.execute(operation, payload, { priority: 'interactive' })

// Aggregate view for metrics, health output and shutdown.
const sherpaWorkerPool = {
  execute: (operation, payload, options) => heavyPool.execute(operation, payload, options),
  stats () {
    const pools = { interactive: interactivePool.stats(), heavy: heavyPool.stats() }
    const ops = {}
    for (const [name, value] of Object.entries(pools)) {
      for (const [operation, metric] of Object.entries(value.ops)) {
        const target = ops[operation] || (ops[operation] = { count: 0, totalMs: 0, maxMs: 0, audioSec: 0, audioBytes: 0, transferredBytes: 0, pools: [] })
        target.count += metric.count
        target.totalMs += metric.totalMs
        target.maxMs = Math.max(target.maxMs, metric.maxMs)
        target.audioSec += metric.audioSec
        target.audioBytes += metric.audioBytes
        target.transferredBytes += metric.transferredBytes
        if (metric.count) target.pools.push(name)
      }
    }
    const merged = {}
    for (const [operation, metric] of Object.entries(ops)) {
      merged[operation] = {
        count: metric.count,
        totalMs: metric.totalMs,
        maxMs: metric.maxMs,
        avgMs: metric.count ? Math.round(metric.totalMs / metric.count) : 0,
        audioSec: Math.round(metric.audioSec * 10) / 10,
        audioBytes: metric.audioBytes,
        transferredBytes: metric.transferredBytes,
        audioMB: Math.round(metric.audioBytes / 1_048_576),
        transferredMB: Math.round(metric.transferredBytes / 1_048_576),
        rtf: metric.audioSec > 0 ? Math.round(metric.totalMs / (metric.audioSec * 1_000) * 1_000) / 1_000 : null,
        pools: metric.pools
      }
    }
    return {
      configured: pools.interactive.configured + pools.heavy.configured,
      workers: pools.interactive.workers + pools.heavy.workers,
      busy: pools.interactive.busy + pools.heavy.busy,
      queued: pools.interactive.queued + pools.heavy.queued,
      inFlight: pools.interactive.inFlight + pools.heavy.inFlight,
      maxQueue: pools.interactive.maxQueue + pools.heavy.maxQueue,
      pools,
      ops: merged
    }
  },
  resetStats () { interactivePool.resetStats(); heavyPool.resetStats() },
  close () { return Promise.all([interactivePool.close(), heavyPool.close()]) }
}

module.exports = {
  modelPaths,
  sherpaWorkerPool,
  assessVoiceprintSample: (audio) => interactive('assessVoiceprintSample', { audio }),
  extractSpeakerEmbedding: (audio) => interactive('extractSpeakerEmbedding', { audio }),
  // Both calls below see the same recording inside one request: retain it once.
  extractDiarizedSpeakerBlocks: (audio, segments) => heavyPool.execute('extractSpeakerBlocks', { audio, segments }, { retainAudio: true }),
  diarizeWav: (audio) => heavyPool.execute('diarizeWav', { audio, segments: [] }, { retainAudio: true }),
  analyzeSileroVad: (audio, options) => interactive('sileroVad', { audio, options }),
  sileroVadStatus: () => interactivePool.execute('sileroStatus', {}, { priority: 'interactive', timeoutMs: 10_000 }),
  dynaudnormWav: (audio) => interactive('dynaudnorm', { audio }),
  audioPreprocessStatus: () => interactivePool.execute('audioPreprocessStatus', {}, { priority: 'interactive', timeoutMs: 10_000 })
}
