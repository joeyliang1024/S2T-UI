// One coordinator per model bucket per process. Redis sees bounded batches,
// not one 15ms polling loop per waiting request.
const createBatchAdmission = ({ acquire, abandon, batchSize = 128, pollMs = 25, minimumProbeMs = 10, maxWaiting = 1000, waitMs = 10000 }) => {
  let queue = [], running = false, timer, closed = false, lastProbeAt = 0
  const failure = message => Object.assign(new Error(message), { status: 503 })
  const settle = (entry, error) => {
    if (entry.settled) return
    entry.settled = true; clearTimeout(entry.timer)
    if (error) entry.reject(error); else entry.resolve()
  }
  const schedule = delay => {
    if (closed || running || timer || !queue.length) return
    timer = setTimeout(() => { timer = null; void flush() }, Math.max(delay, lastProbeAt + minimumProbeMs - Date.now()))
  }
  const flush = async () => {
    if (running || closed) return
    queue = queue.filter(entry => !entry.settled)
    const batch = queue.slice(0, batchSize)
    if (!batch.length) return
    running = true; lastProbeAt = Date.now()
    let granted = []
    try {
      const result = await acquire(batch.map(entry => entry.token), Math.min(...batch.map(entry => entry.deadline)))
      if (!Array.isArray(result)) throw failure('Invalid capacity admission response')
      granted = new Set(result.map(String))
      const expired = []
      for (const entry of batch) if (granted.has(entry.token)) {
        if (entry.settled || closed || Date.now() >= entry.deadline) { settle(entry, failure('模型容量等待逾時')); expired.push(entry.token) }
        else settle(entry)
      }
      if (expired.length) await abandon(expired)
    } catch (error) {
      // An unacknowledged EVAL may have acquired leases. Never leave those
      // orphaned until the 120s lease expires, including during Sentinel failover.
      for (const entry of queue) settle(entry, error)
      await abandon(batch.map(entry => entry.token))
    } finally {
      running = false
      queue = queue.filter(entry => !entry.settled)
      schedule(granted.size === batch.length ? 0 : pollMs)
    }
  }
  return {
    request(token) {
      if (closed) return Promise.reject(failure('模型容量服務正在關閉'))
      if (queue.length >= maxWaiting) return Promise.reject(failure('模型容量等待佇列已滿'))
      return new Promise((resolve, reject) => {
        const entry = { token, resolve, reject, settled: false, deadline: Date.now() + waitMs, timer: null }
        entry.timer = setTimeout(() => {
          settle(entry, failure('模型容量等待逾時'))
          queue = queue.filter(item => item !== entry)
        }, waitMs)
        queue.push(entry); schedule(0)
      })
    },
    notify() { if (timer) { clearTimeout(timer); timer = null }; schedule(0) },
    stats: () => ({ waiting: queue.length, probing: running ? 1 : 0 }),
    close() { closed = true; clearTimeout(timer); for (const entry of queue) settle(entry, failure('模型容量服務正在關閉')); queue = [] }
  }
}
module.exports = { createBatchAdmission }
