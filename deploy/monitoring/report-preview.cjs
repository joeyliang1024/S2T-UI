// Bounded, explicitly synthetic Grafana preview; never calls models or writes user storage.
const { createServer } = require('node:http')
const metrics = require('./metrics.cjs')
const usage = require('./usage-metrics.cjs')
const departments = ['測試－研發部', '測試－營運部', '測試－設計部']
const accounts = departments.flatMap((Department, d) => Array.from({ length: 4 }, (_, u) => ({ id: `report-preview-${d}-${u}`, NT: `測試${d + 1}-${u + 1}`, Department })))
for (const user of accounts) usage.registerUser(user)
let tick = 0
let requests = 0
let errors = 0
const deadline = Date.now() + 15 * 60 * 1000
const produce = () => {
  tick++
  for (const [index, user] of accounts.entries()) {
    const d = Math.floor(index / 4), u = index % 4
    if (tick === 1) usage.observeJourney(user.id, 'L1')
    if (u > 3 - d || (tick + u) % (d + 1)) continue
    usage.observeJourney(user.id, 'L2')
    if (u < 3 - d && tick % 2 === 0) usage.observeJourney(user.id, 'L3')
    const status = (tick + index) % 17 === 0 ? 422 : (tick + index) % 23 === 0 ? 503 : 200
    const failed = status >= 400
    usage.observeRequest(user.id, 'translations', status, .7)
    requests++; if (failed) errors++
    metrics.observe('s2t_gateway_request_duration_seconds', { route: 'translations' }, .7, failed)
    if (failed) continue
    const wobble = (tick % 9) * .035
    const asr = { t1_queue: .04 + d * .02, t1_encode: .025, t1_upload: .06, t2_vad: .08, t2_gate: .045, t3_queue: .02, t3_model: .65 + d * .22 + wobble, t3_gateway: .025, t4_postprocess: .015, t5_network: .075, t5_paint: .02 }
    const translation = { t6_wait: .1, t6_queue: .025, t6_model: .55 + d * .16 + wobble, t6_gateway: .02, t7_network: .06, t7_paint: .025 }
    const total = object => Object.values(object).reduce((sum, n) => sum + n, 0)
    const slices = { ...asr, ...translation }
    const phases = Object.entries(slices).reduce((map, [stage, seconds]) => { const phase = 'phase_' + stage.slice(0, 2); map[phase] = (map[phase] || 0) + seconds; return map }, {})
    metrics.acceptCaptionSamples({ samples: [...Object.entries({ ...slices, ...phases, e2e_asr: total(asr), e2e_translation: total(slices), e2e_translation_tail: total(slices) }).map(([stage, seconds]) => ({ stage, seconds }))], events: { speech_detected: 1 } })
    metrics.observe('s2t_server_stage_duration_seconds', { stage: 'translation_model' }, translation.t6_model)
    const audio = Buffer.alloc(44 + 32000 * (20 + index * 3)); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40)
    usage.observeExecution(user.id, 'transcriptions', { audio })
    usage.observeExecution(user.id, 'translations', { input: 'Preview only', output: '報表預覽', usage: { prompt_tokens: 48, completion_tokens: 16 } })
  }
}
const server = createServer((request, response) => {
  if (request.url === '/healthz') return response.end('preview only')
  if (request.url !== '/metrics') { response.statusCode = 404; return response.end() }
  response.setHeader('content-type', 'text/plain; version=0.0.4')
  response.end(metrics.render() + usage.render() + `# TYPE s2t_gateway_request_errors_total counter\ns2t_gateway_request_errors_total{route="translations"} ${errors}\n# TYPE s2t_report_preview gauge\ns2t_report_preview 1\n`)
})
server.listen(8787, '0.0.0.0')
// Let Prometheus capture all zero counters before the first cohort.
setTimeout(() => {
  produce()
  const interval = setInterval(() => { if (Date.now() >= deadline) clearInterval(interval); else produce() }, 5000)
}, 15000)
