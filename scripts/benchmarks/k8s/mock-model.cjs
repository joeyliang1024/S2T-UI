const { createServer } = require('node:http')
let active = 0, peak = 0, completed = 0
createServer(async (request, response) => {
  if (request.url === '/metrics') { response.setHeader('content-type', 'text/plain'); return response.end(`s2t_mock_model_active ${active}\ns2t_mock_model_peak ${peak}\ns2t_mock_model_completed_total ${completed}\n`) }
  if (request.url === '/healthz') return response.end('ok')
  for await (const chunk of request) { /* consume complete request */ }
  active++; peak = Math.max(peak, active)
  const started = performance.now()
  await new Promise(resolve => setTimeout(resolve, 500))
  active--; completed++
  response.setHeader('content-type', 'application/json')
  response.setHeader('server-timing', `model;dur=${performance.now() - started}`)
  response.end(JSON.stringify(request.url.includes('/audio/transcriptions') ? { text: 'Performance test caption.', language: 'en' } : { choices: [{ message: { content: '效能測試字幕。' } }] }))
}).listen(9090, '0.0.0.0')
