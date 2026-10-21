// Slow additive growth, fast multiplicative decrease. The hard ceiling is a
// deployment budget, never inferred from the number of users.
const createAdaptiveCapacity = ({ minimum = 1, maximum, initial = minimum, idleFloor = minimum, growthMs = 1000, idleMs = 2000, cooldownMs = 5000, waitMs = 3000, maxWaiting = 2000, healthyMs = 100, now = Date.now, onLimit = () => {} }) => {
  if (!Number.isSafeInteger(maximum) || maximum < minimum) throw new Error('Invalid adaptive capacity ceiling')
  let limit = Math.max(minimum, Math.min(initial, maximum)), active = 0, lastGrowth = now(), cooldownUntil = 0, idleTimer, closed = false
  const waiting = []
  const setLimit = value => { limit = Math.max(minimum, Math.min(maximum, value)); onLimit(limit) }
  const dispatch = () => {
    while (!closed && active < limit && waiting.length) {
      const entry = waiting.shift(); clearTimeout(entry.timer); active++
      entry.resolve(permit())
    }
  }
  const decrease = () => {
    // A burst of failures describes one overload episode. Repeatedly halving
    // for every failed waiter collapses capacity and keeps extending cooldown.
    if (now() < cooldownUntil) return
    setLimit(Math.floor(limit / 2)); cooldownUntil = now() + cooldownMs
  }
  const permit = () => {
    const started = now(); let returned = false
    return error => {
      if (returned) return
      returned = true; active--
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
    acquire() {
      if (closed) return Promise.reject(Object.assign(new Error('Connection admission closed'), { status: 503 }))
      clearTimeout(idleTimer)
      if (active < limit) { active++; return Promise.resolve(permit()) }
      if (waiting.length >= maxWaiting) return Promise.reject(Object.assign(new Error('Connection admission queue full'), { status: 503 }))
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null }
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1)
          reject(Object.assign(new Error('Connection admission timed out'), { status: 503 }))
        }, waitMs)
        waiting.push(entry)
      })
    },
    failed: decrease,
    stats: () => ({ limit, active, waiting: waiting.length, maximum }),
    close() { closed = true; clearTimeout(idleTimer); for (const entry of waiting.splice(0)) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('Connection admission closed'), { status: 503 })) } }
  }
}
module.exports = { createAdaptiveCapacity }
