// Bound admission independently of the operation's downstream connection pool.
// A queued task owns no client; timing out removes it rather than leaving a
// promise chain that can only move when an earlier request finally completes.
const createConcurrencyGate = ({ maximum, maxWaiting = 1000, waitMs = 10000, busyMessage = 'Capacity queue is full', timeoutMessage = 'Capacity wait timed out' }) => {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(maxWaiting) || maxWaiting < 0 || !Number.isFinite(waitMs) || waitMs <= 0) throw new Error('Invalid concurrency gate configuration')
  let active = 0
  const waiting = []
  const failure = message => Object.assign(new Error(message), { status: 503 })
  const release = () => {
    active--
    const next = waiting.shift()
    if (next) { clearTimeout(next.timer); active++; next.resolve() }
  }
  const run = async (operation, { cleanup = false } = {}) => {
    if (active < maximum) active++
    else {
      if (!cleanup && waiting.length >= maxWaiting) throw failure(busyMessage)
      await new Promise((resolve, reject) => {
        const entry = { resolve, timer: null }
        if (!cleanup) entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry)
          if (index >= 0) waiting.splice(index, 1)
          reject(failure(timeoutMessage))
        }, waitMs)
        if (cleanup) waiting.unshift(entry)
        else waiting.push(entry)
      })
    }
    try { return await operation() } finally { release() }
  }
  run.stats = () => ({ active, waiting: waiting.length, maximum })
  return run
}
module.exports = { createConcurrencyGate }
