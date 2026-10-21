const { createServer } = require('node:http')
const { observeHttp } = require('../metrics.cjs')

const createHttpApp = ({ handleHttpRequest, send, logger, newRequestId, isQuiescing = () => false, isDraining = () => false, onRequestOpened = () => {}, onRequestClosed = () => {} }) => {
const incomingRequestId = (request) => {
  const header = request.headers['x-request-id']
  if (typeof header === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(header)) return header
  return newRequestId()
}
const requestPathOf = (request) => {
  try { return new URL(request.url, 'http://localhost').pathname } catch { return 'unknown' }
}
// Per-request success logs are opt-in debug output. At hundreds of requests
// per second stdout serialization/backpressure competes with inference I/O.
// Status/latency metrics still cover every request; errors retain their levels.
const probePaths = new Set(['/livez', '/metrics'])
const httpLogLevel = (status, probe) => {
  if (status === 503 || status === 429 || status === 409) return 'warn'
  if (status >= 500) return 'error'
  if (status >= 400) return probe || status === 401 || status === 403 ? 'info' : 'warn'
  return 'debug'
}
return createServer((request, response) => {
  // Same monotonic clock as route timings; includes auth/admission/DB waits.
  request.s2tStartedAt = performance.now()
  onRequestOpened(response)
  if (isQuiescing()) response.setHeader('connection', 'close')
  response.once('close', () => onRequestClosed(response))
  const requestId = incomingRequestId(request)
  const path = requestPathOf(request)
  const startedAt = performance.now()
  const probe = probePaths.has(path) || !path.startsWith('/api/')
  response.setHeader('x-request-id', requestId)
  let observed = false
  const record = aborted => {
    if (observed) return
    observed = true
    observeHttp(request.method, path, response.statusCode, aborted)
  }
  response.once('close', () => record(!response.writableFinished))
  response.once('finish', () => {
    record(false)
    logger.log(httpLogLevel(response.statusCode, probe), 'http.request', {
      method: request.method,
      path,
      status: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt)
    })
  })
  logger.run({ requestId }, () => {
    if (isDraining() && request.url !== '/livez' && request.url !== '/readyz') { response.setHeader('connection', 'close'); return send(response, 503, { error: '服務正在排空，請重試' }) }
    void Promise.resolve().then(() => handleHttpRequest(request, response)).catch((error) => {
      logger.error('http.request.failed', {
        method: request.method,
        path,
        durationMs: Math.round(performance.now() - startedAt),
        error
      })
      if (!response.headersSent && !response.writableEnded) send(response, 503, { error: '服務暫時無法處理此請求，請稍後重試' })
      else response.destroy()
    })
  })
})
}
module.exports = { createHttpApp }
