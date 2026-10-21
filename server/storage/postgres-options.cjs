const { logger } = require('../logger.cjs')
const positive = (config, key, fallback) => {
  if (config[key] === undefined || config[key] === '') return fallback
  const value = Number(config[key])
  if (!Number.isSafeInteger(value) || value <= 0 || value > 600000) throw new Error(`${key} must be an integer in 1..600000`)
  return value
}
const postgresOptions = config => ({
  host: config.S2T_POSTGRES_HOST, port: Number(config.S2T_POSTGRES_PORT), database: config.S2T_POSTGRES_DB_NAME,
  user: config.S2T_POSTGRES_USER, password: config.S2T_POSTGRES_PASSWORD,
  max: Math.min(100, positive(config, 'S2T_POSTGRES_MAX_CONNECTIONS', 10)),
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: positive(config, 'S2T_POSTGRES_CONNECT_TIMEOUT_MS', 3000),
  keepAlive: true,
  keepAliveInitialDelayMillis: positive(config, 'S2T_POSTGRES_KEEPALIVE_DELAY_MS', 1000),
  statement_timeout: positive(config, 'S2T_POSTGRES_STATEMENT_TIMEOUT_MS', 5000),
  query_timeout: positive(config, 'S2T_POSTGRES_QUERY_TIMEOUT_MS', 6000),
  lock_timeout: positive(config, 'S2T_POSTGRES_LOCK_TIMEOUT_MS', 3000),
  idle_in_transaction_session_timeout: positive(config, 'S2T_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS', 10000)
})
const observePoolErrors = (pool, role) => {
  // Idle sockets can die without an awaiting query. Consume the pool error
  // event; pg removes the dead client and creates a replacement on demand.
  pool.on('error', error => logger.error('storage.postgres.connection.failed', { role, error }))
  return pool
}
module.exports = { postgresOptions, observePoolErrors }
