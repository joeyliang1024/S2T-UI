const { startGateway } = require('./bootstrap.cjs')

if (require.main === module) {
  const runtime = startGateway()
  const { logger } = require('./logger.cjs')
  const stop = () => { void runtime.stop().then(() => process.exit(0), error => { logger.error('gateway.shutdown.failed', { error }); process.exit(1) }) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  process.on('SIGUSR2', runtime.prepareForShutdown)
  process.on('unhandledRejection', reason => logger.error('process.unhandled-rejection', { error: reason }))
}

module.exports = { startGateway }
