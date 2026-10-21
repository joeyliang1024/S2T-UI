const { AsyncLocalStorage } = require('node:async_hooks')
const context = new AsyncLocalStorage()
const backgroundRoutes = new Set(['/api/summaries', '/api/diarizations'])
const modelRoutes = new Set(['/api/transcriptions', '/api/translations', ...backgroundRoutes])
const workloadForRequest = request => {
  let path
  try { path = new URL(request.url, 'http://localhost').pathname } catch { path = '' }
  return backgroundRoutes.has(path) || request.headers['x-s2t-workload'] === 'background' ? 'background' : 'realtime'
}
const currentWorkload = () => context.getStore() || 'realtime'
const runWithWorkload = (workload, operation) => context.run(workload === 'background' ? 'background' : 'realtime', operation)
module.exports = { workloadForRequest, currentWorkload, runWithWorkload, modelRoutes }
