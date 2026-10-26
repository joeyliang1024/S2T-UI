const { createServer } = require('node:http')
let active = 0, peak = 0, completed = 0
const work = {realtime:{active:0,peak:0,completed:0},background:{active:0,peak:0,completed:0}}
const handle = async (request, response) => {
  if (request.url === '/metrics') { response.setHeader('content-type', 'text/plain'); return response.end(Object.entries(work).map(([name,x])=>`s2t_mock_workload_active{workload="${name}"} ${x.active}\ns2t_mock_workload_peak{workload="${name}"} ${x.peak}\ns2t_mock_workload_completed_total{workload="${name}"} ${x.completed}\n`).join('')+`s2t_mock_model_active ${active}\ns2t_mock_model_peak ${peak}\ns2t_mock_model_completed_total ${completed}\n`) }
  if (request.url === '/healthz') return response.end('ok')
  if (request.url.endsWith('/models')) { response.setHeader('content-type','application/json'); return response.end(JSON.stringify({data:[{id:'performance'}]})) }
  const parts = []; let bytes = 0
  for await (const chunk of request) {
    if (request.url.includes('/chat/completions')) { bytes += chunk.length; if (bytes > 1024*1024) { response.writeHead(413); return response.end() }; parts.push(chunk) }
  }
  let input = {}; try { if (parts.length) input = JSON.parse(Buffer.concat(parts)) } catch { response.writeHead(400); return response.end() }

  const group=work[request.headers['x-s2t-workload']==='background'?'background':'realtime']
  group.active++;group.peak=Math.max(group.peak,group.active)
  active++; peak = Math.max(peak, active)
  const started = performance.now()
  await new Promise(resolve => setTimeout(resolve, 500))
  active--; completed++;group.active--;group.completed++
  if (input.stream) {
    response.setHeader('content-type','text/event-stream')
    response.write('data: '+JSON.stringify({choices:[{delta:{content:'Deployment summary.'}}]})+'\n\n')
    await new Promise(resolve=>setTimeout(resolve,20))
    return response.end('data: [DONE]\n\n')
  }
  response.setHeader('content-type', 'application/json')
  response.setHeader('server-timing' , `model;dur=${performance.now() - started}`)
  response.end(JSON.stringify(request.url.includes('/audio/transcriptions') ? { text: 'Performance test caption.', language: 'en' } : { choices: [{ message: { content: '效能測試字幕。' } }] }))
}
// Client cancellation during upload is expected under pressure; contain it per request.
createServer((request, response) => { void handle(request, response).catch(() => response.destroy()) }).listen(Number(process.env.PORT || 9090), '0.0.0.0')
