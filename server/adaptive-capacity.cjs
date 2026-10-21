// Slow additive growth, fast multiplicative decrease. The hard ceiling is a
// deployment budget, never inferred from the number of users.
const createAdaptiveCapacity = ({ minimum = 1, maximum, initial = minimum, idleFloor = minimum, growthMs = 1000, idleMs = 2000, cooldownMs = 5000, waitMs = 3000, maxWaiting = 2000, healthyMs = 100, backgroundMaximum = maximum, backgroundWaitMs = waitMs, now = Date.now, onLimit = () => {} }) => {
  if (!Number.isSafeInteger(maximum) || maximum < minimum) throw new Error('Invalid adaptive capacity ceiling')
  let limit = Math.max(minimum, Math.min(initial, maximum)), active = 0, lastGrowth = now(), cooldownUntil = 0, idleTimer, closed = false
  const waiting = []
  let backgroundActive = 0
  const backgroundLimit = () => Math.min(backgroundMaximum, Math.max(1, Math.floor(limit / 4)))
  const cleanup = entry => { clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort) }
  const setLimit = value => { limit = Math.max(minimum, Math.min(maximum, value)); onLimit(limit) }
  const dispatch = () => {
    while (!closed && active < limit && waiting.length) {
      let index = waiting.findIndex(entry => entry.priority !== 'background')
      if (index < 0) {
        if (backgroundActive >= backgroundLimit()) break
        index = 0
      }
      const [entry] = waiting.splice(index, 1); cleanup(entry); active++
      if (entry.priority === 'background') backgroundActive++
      entry.resolve(permit(entry.priority))
    }
  }
  const decrease = () => {
    // A burst of failures describes one overload episode. Repeatedly halving
    // for every failed waiter collapses capacity and keeps extending cooldown.
    if (now() < cooldownUntil) return
    setLimit(Math.floor(limit / 2)); cooldownUntil = now() + cooldownMs
  }
  const permit = priority => {
    const started = now(); let returned = false
    return error => {
      if (returned) return
      returned = true; active--
      if (priority === 'background') backgroundActive--
      const duration = now() - started
      if (error || duration > healthyMs * 4) decrease()
      else if (waiting.length && duration <= healthyMs && now() >= cooldownUntil && now() - lastGrowth >= growthMs) {
        setLimit(limit + 1); lastGrowth = now()
      }
      dispatch()
      if (!active && !waiting.length && !closed) {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => { idleTimer = null; if (!active && !waiting.length) setLimit(now() < cooldownUntil ? minimum : idleFloor) }, idleMs)
        idleTimer.unref?.()
      }
    }
  }
  return {
    acquire({ priority = 'realtime', signal } = {}) {
      if (closed) return Promise.reject(Object.assign(new Error('Connection admission closed'), { status: 503 }))
      if (signal?.aborted) return Promise.reject(new DOMException('Admission canceled', 'AbortError'))
      clearTimeout(idleTimer)
      const background = priority === 'background'
      if (!waiting.length && active < limit && (!background || backgroundActive < backgroundLimit())) {
        active++; if (background) backgroundActive++
        return Promise.resolve(permit(priority))
      }
      if (waiting.length >= maxWaiting || (background && waiting.filter(entry => entry.priority === 'background').length >= Math.min(128, maxWaiting))) return Promise.reject(Object.assign(new Error('Connection admission queue full'), { status: 503 }))
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, priority, signal, timer: null, abort: null }
        const remove = error => {
          const index = waiting.indexOf(entry)
          if (index < 0) return
          waiting.splice(index, 1); cleanup(entry); reject(error); dispatch()
        }
        entry.abort = () => remove(new DOMException('Admission canceled', 'AbortError'))
        entry.timer = setTimeout(() => remove(Object.assign(new Error('Connection admission timed out'), { status: 503 })), background ? backgroundWaitMs : waitMs)
        waiting.push(entry)
        signal?.addEventListener('abort', entry.abort, { once: true })
        if (signal?.aborted) entry.abort(); else dispatch()
      })
    },
    failed: decrease,
    stats: () => ({ limit, active, waiting: waiting.length, maximum, backgroundActive, backgroundLimit: backgroundLimit(), realtimeWaiting: waiting.filter(entry => entry.priority !== 'background').length, backgroundWaiting: waiting.filter(entry => entry.priority === 'background').length }),
    close() { closed = true; clearTimeout(idleTimer); for (const entry of waiting.splice(0)) { cleanup(entry); entry.reject(Object.assign(new Error('Connection admission closed'), { status: 503 })) } }
  }
}
module.exports = { createAdaptiveCapacity }
