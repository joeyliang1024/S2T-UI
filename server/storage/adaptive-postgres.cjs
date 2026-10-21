const { createAdaptiveCapacity } = require('../adaptive-capacity.cjs')
// Intercept the public checkout API: Pool.query also goes through connect.
// Do not mutate pg's private queues or disconnect an active transaction.
const adaptPostgresPool = pool => {
  // Checkout duration includes the entire transaction and JS processing, not
  // just PostgreSQL latency. A normal metadata transaction must not collapse
  // the pool during a CPU burst; actual connection/query errors shrink it.
  // Start with the explicitly budgeted window, while pg still opens sockets
  // lazily. A startup burst must not spend its SLA ramping an artificial gate.
  const capacity = createAdaptiveCapacity({ minimum: Math.min(4, pool.options.max), maximum: pool.options.max, initial: pool.options.max, idleFloor: Math.min(4, pool.options.max), growthMs: 250, healthyMs: 1000 })
  const connect = pool.connect.bind(pool), end = pool.end.bind(pool)
  pool.connect = callback => {
    const pending = capacity.acquire().then(async releasePermit => {
      try {
        const client = await connect(), releaseClient = client.release
        client.release = error => { try { return releaseClient(error) } finally { releasePermit(error) } }
        return client
      } catch (error) { releasePermit(error); throw error }
    })
    if (callback) { void pending.then(client => callback(null, client, client.release), error => callback(error)); return }
    return pending
  }
  pool.adaptiveStats = capacity.stats
  pool.on('error', capacity.failed)
  pool.end = callback => {
    capacity.close()
    return end(callback)
  }
  return pool
}
module.exports = { adaptPostgresPool }
