// Use the actual pg driver against a tiny protocol peer that deliberately
// blackholes queries. This tests client deadlines even when PostgreSQL cannot
// deliver its server-side statement_timeout response.
const assert = require('node:assert/strict')
const net = require('node:net')
const { Pool } = require('pg')
const { postgresOptions, observePoolErrors } = require('../../server/storage/postgres-options.cjs')
const { adaptPostgresPool } = require('../../server/storage/adaptive-postgres.cjs')
const packet = (type, bytes) => {
  const result = Buffer.alloc(5 + bytes.length)
  result.write(type); result.writeInt32BE(bytes.length + 4, 1); bytes.copy(result, 5)
  return result
}
;(async () => {
  const sockets = new Set()
  let accepted = 0, queries = 0
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    accepted++
    let startup = true
    socket.on('data', bytes => {
      if (startup) {
        startup = false
        socket.write(Buffer.concat([packet('R', Buffer.alloc(4)), packet('Z', Buffer.from('I'))]))
      } else if (bytes[0] === 81) { queries++ /* query sent: never reply */ }
    })
  })
  let pool
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const options = postgresOptions({ S2T_POSTGRES_HOST: '127.0.0.1', S2T_POSTGRES_PORT: String(server.address().port), S2T_POSTGRES_USER: 'fixture', S2T_POSTGRES_DB_NAME: 'fixture', S2T_POSTGRES_MAX_CONNECTIONS: '1', S2T_POSTGRES_QUERY_TIMEOUT_MS: '100', S2T_POSTGRES_CONNECT_TIMEOUT_MS: '200' })
    pool = adaptPostgresPool(observePoolErrors(new Pool(options), 'blackhole-test'))
    for (let i = 0; i < 2; i++) {
      const started = performance.now()
      await assert.rejects(pool.query('SELECT forever'), /timeout/i)
      assert.ok(performance.now() - started < 1000, 'blackholed query must settle')
    }
    assert.equal(queries, 2)
    assert.equal(accepted, 2, 'timed-out clients must be destroyed, not reused')
    assert.equal(pool.waitingCount, 0)
    assert.equal(pool.adaptiveStats().waiting, 0)
    assert.equal(pool.adaptiveStats().active, 0)
    console.log('PASS actual pg driver blackhole query timeout, dead-client eviction, reconnection and no waiting-pool leak')
  } finally {
    if (pool) await pool.end()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
