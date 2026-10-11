const { createServer } = require('node:http')
const stats = { counts: {}, active: {}, peak: {}, rejected: 0 }
let controls = { asrMs: 400, translationMs: 180, diarizationMs: 750, errorEvery: 0 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
createServer(async (req, res) => {
  if (req.url === '/healthz') return send(res, 200, { mock: true })
  if (req.url === '/stats') return send(res, 200, { mock: true, controls, ...stats })
  const parts = []; for await (const part of req) parts.push(part)
  if (req.url === '/control') { Object.assign(controls, JSON.parse(Buffer.concat(parts))); return send(res, 200, controls) }
  let kind
  if (req.url === '/v1/models') return send(res, 200, { data: [{ id: 'mock-asr' }, { id: 'mock-translation' }, { id: 'mock-diarization' }] })
  if (req.url === '/v1/audio/transcriptions') kind = 'asr'
  else if (req.url === '/v1/chat/completions') kind = 'translation'
  else if (req.url === '/diarizations') kind = 'diarization'
  else if (req.url.startsWith('/internal/audio/')) kind = req.url.split('/').pop()
  else { stats.rejected++; return send(res, 404, { error: 'Only isolated mock routes are implemented.' }) }
  stats.counts[kind] = (stats.counts[kind] || 0) + 1
  stats.active[kind] = (stats.active[kind] || 0) + 1
  stats.peak[kind] = Math.max(stats.peak[kind] || 0, stats.active[kind])
  try {
    await sleep(controls[`${kind}Ms`] || 20)
    if (controls.errorEvery && stats.counts[kind] % controls.errorEvery === 0) return send(res, 503, { error: 'injected mock failure' })
    if (kind === 'asr') return send(res, 200, { text: 'Isolated simulated speech for capacity testing.', language: 'en' })
    if (kind === 'translation') return send(res, 200, { id: 'mock-completion', choices: [{ message: { role: 'assistant', content: '這是隔離壓測的模擬翻譯。' }, finish_reason: 'stop' }] })
    if (kind === 'diarization') return send(res, 200, { model: 'mock-diarization', exclusive_diarization: [{ start: 0, end: 1.5, speaker: 'SPEAKER_01' }] })
    const vector = Array.from({ length: 192 }, (_, i) => i === 0 ? 1 : 0)
    let value = null
    if (kind === 'extractSpeakerEmbedding') value = vector
    if (kind === 'extractDiarizedSpeakerBlocks') value = [{ speaker: 'SPEAKER_01', speechMs: 1500, blocks: [{ index: 0, startSec: 0, endSec: 1.5, durationMs: 1500, rmsDbfs: -18, embedding: vector }] }]
    if (kind === 'extractSpeakerLabelEmbeddings') value = { SPEAKER_01: vector }
    if (kind === 'assessVoiceprintSample') value = { durationMs: 15000, rmsDbfs: -18, quality: 'good', speechRatio: 1 }
    if (kind === 'analyzeSileroVad') value = { speech: [{ start: 0, end: 1.5 }] }
    if (kind === 'diarizeWav') value = [{ start: 0, end: 1.5, speaker: 'SPEAKER_01' }]
    if (kind === 'audioPreprocessStatus') value = { sileroVad: { available: false }, dynaudnorm: { available: false } }
    return send(res, 200, { value })
  } finally { stats.active[kind]-- }
}).listen(9090, '0.0.0.0', () => console.log('Isolated model mocks listening on 9090; no upstream forwarding exists.'))
