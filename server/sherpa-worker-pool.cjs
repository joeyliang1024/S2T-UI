const { Worker } = require('node:worker_threads')
const { join } = require('node:path')
const { modelPaths } = require('./sherpa-diarization.cjs')

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

// The initial production default is deliberately one CPU-heavy job per pod.
// Operators scale dedicated audio-worker pods before increasing this value.
class SherpaWorkerPool {
  constructor ({ size = positiveInteger(process.env.S2T_SHERPA_WORKERS, 1), maxQueue = positiveInteger(process.env.S2T_SHERPA_MAX_QUEUE, 8), timeoutMs = positiveInteger(process.env.S2T_SHERPA_JOB_TIMEOUT_MS, 120_000) } = {}) {
    this.size = size
    this.maxQueue = maxQueue
    this.timeoutMs = timeoutMs
    this.workers = []
    this.queue = []
    this.jobs = new Map()
    this.nextId = 1
    this.closed = false
  }

  start () {
    while (!this.closed && this.workers.length < this.size) this.spawn()
  }

  spawn () {
    const entry = { worker: new Worker(join(__dirname, 'sherpa-worker.cjs')), busy: false, jobId: null, intentionalExit: false }
    entry.worker.on('message', (message) => this.complete(entry, message))
    entry.worker.on('error', (error) => this.failWorker(entry, error))
    entry.worker.on('exit', (code) => {
      if (!entry.intentionalExit && code !== 0) this.failWorker(entry, new Error(`sherpa worker 非正常結束（code ${code}）`))
      this.workers = this.workers.filter((item) => item !== entry)
      if (!this.closed) { this.start(); this.dispatch() }
    })
    this.workers.push(entry)
  }

  execute (operation, payload, { priority = 'background', timeoutMs = this.timeoutMs, signal } = {}) {
    if (this.closed) return Promise.reject(new Error('sherpa worker pool 已關閉'))
    if (signal?.aborted) return Promise.reject(new Error('sherpa 工作已取消'))
    if (this.queue.length + this.jobs.size >= this.maxQueue) return Promise.reject(new Error('語者處理佇列已滿，請稍後再試'))
    this.start()
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, operation, payload, resolve, reject, timeoutMs, signal }
      job.cancel = () => {
        const queuedAt = this.queue.indexOf(job)
        if (queuedAt !== -1) { this.queue.splice(queuedAt, 1); reject(new Error('sherpa 工作已取消')); return }
        if (!this.jobs.has(job.id)) return
        const entry = this.workers.find((item) => item.jobId === job.id)
        this.finishJob(job, new Error('sherpa 工作已取消'))
        if (entry) { entry.intentionalExit = true; entry.worker.terminate().catch(() => undefined) }
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

  dispatch () {
    for (const entry of this.workers) {
      if (entry.busy || !this.queue.length) continue
      const job = this.queue.shift()
      entry.busy = true; entry.jobId = job.id
      job.timer = setTimeout(() => {
        if (!this.jobs.has(job.id)) return
        this.finishJob(job, new Error(`sherpa ${job.operation} 逾時`))
        entry.intentionalExit = true
        entry.worker.terminate().catch(() => undefined)
      }, job.timeoutMs)
      this.jobs.set(job.id, job)
      try { entry.worker.postMessage({ id: job.id, operation: job.operation, payload: job.payload }) } catch (error) { this.finishJob(job, error); entry.busy = false; entry.jobId = null }
    }
  }

  complete (entry, message) {
    const job = this.jobs.get(message?.id)
    if (!job) return
    entry.busy = false; entry.jobId = null
    this.finishJob(job, message.error ? Object.assign(new Error(message.error.message), { stack: message.error.stack }) : null, message.value)
    this.dispatch()
  }

  finishJob (job, error, value) {
    if (!this.jobs.delete(job.id)) return
    clearTimeout(job.timer)
    job.signal?.removeEventListener('abort', job.cancel)
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

  stats () { return { configured: this.size, workers: this.workers.length, busy: this.workers.filter((item) => item.busy).length, queued: this.queue.length, inFlight: this.jobs.size, maxQueue: this.maxQueue } }
}

const pool = new SherpaWorkerPool()
const interactive = (operation, audio) => pool.execute(operation, { audio }, { priority: 'interactive' })
module.exports = {
  modelPaths,
  sherpaWorkerPool: pool,
  assessVoiceprintSample: (audio) => interactive('assessVoiceprintSample', audio),
  extractSpeakerEmbedding: (audio) => interactive('extractSpeakerEmbedding', audio),
  extractDiarizedSpeakerEmbeddings: (audio, segments) => pool.execute('extractDiarizedSpeakerEmbeddings', { audio, segments }),
  diarizeWav: (audio) => pool.execute('diarizeWav', { audio, segments: [] }),
  analyzeSileroVad: (audio, options) => pool.execute('sileroVad', { audio, options }, { priority: 'interactive' }),
  sileroVadStatus: () => pool.execute('sileroStatus', {}, { priority: 'interactive', timeoutMs: 10_000 }),
  dynaudnormWav: (audio) => pool.execute('dynaudnorm', { audio }, { priority: 'interactive' }),
  audioPreprocessStatus: () => pool.execute('audioPreprocessStatus', {}, { priority: 'interactive', timeoutMs: 10_000 })
}
