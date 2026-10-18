const assert = require('node:assert/strict')
const { openaiHealth, modelProbeKind } = require('../../server/model-health.cjs')
const model = { id: 'fixture', requiresApiKey: true }
const service = { endpoint: 'https://fixture.invalid/v1', model: 'fixture-model', apiKey: 'secret-fixture-key' }
const probe = (fetch) => openaiHealth(model, service, { baseUrl: value => value, fetch })
;(async () => {
  assert.equal((await probe(async () => Response.json({ data: [{ id: service.model }] }))).state, 'healthy')
  assert.match((await probe(async () => Response.json({ data: [] }))).reason, /fixture-model/)
  assert.equal((await probe(async () => new Response('invalid JSON'))).state, 'degraded')
  for (const status of [401, 403, 404, 429, 503]) {
    const result = await probe(async () => Response.json({ error: { message: `provider detail ${service.apiKey} Bearer hidden-value` } }, { status }))
    assert.equal(result.state, status === 404 ? 'degraded' : 'unhealthy')
    assert.match(result.reason, new RegExp(`HTTP ${status}`))
    assert.match(result.reason, /provider detail/)
    assert.ok(!result.reason.includes(service.apiKey) && !result.reason.includes('hidden-value'))
  }
  assert.match((await probe(async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) })).reason, /連線被拒/)
  assert.match((await probe(async () => { throw new DOMException('timeout', 'TimeoutError') })).reason, /逾時/)
  assert.match((await openaiHealth(model, null)).reason, /API key/)
  assert.equal((await openaiHealth(model, { ...service, endpoint: 'wss://fixture.invalid/asr' })).state, 'unknown')
  assert.equal(modelProbeKind({ name: 'sherpa remote', endpoint: 'http://localhost:8000/v1' }), 'openai')
  assert.equal(modelProbeKind({ endpoint: '/api/diarizations' }), 'sherpa')
  assert.equal(modelProbeKind({ endpoint: '/api/audio-processing/silero-vad' }), 'silero')
  console.log('PASS model health: availability, missing model, malformed response, HTTP diagnostics, safe provider detail, connection refusal and timeout')
})().catch(error => { console.error(error); process.exitCode = 1 })
