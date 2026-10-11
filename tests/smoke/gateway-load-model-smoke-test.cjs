const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
;(async () => {
  const root = await mkdtemp(join(tmpdir(), 's2t-arrivals-'))
  let latency = 0
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {}
    await new Promise(resolve => setTimeout(resolve, latency))
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ text: 'test' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const tokens = join(root, 'tokens.json')
    await writeFile(tokens, JSON.stringify(Array.from({ length: 150 }, (_, index) => `mock-token-${index}`)))
    const env = { ...process.env, S2T_LOAD_BASE_URL: `http://127.0.0.1:${server.address().port}`, S2T_LOAD_TOKENS_FILE: tokens, S2T_LOAD_TOKEN: '', S2T_LOAD_WAV: 'tests/fixtures/speech-sample.wav', S2T_LOAD_CONCURRENCY: '150', S2T_LOAD_DURATION_SECONDS: '1', S2T_LOAD_INTERVAL_MS: '1000', S2T_LOAD_MAX_INFLIGHT: '600' }
    const success = JSON.parse((await promisify(execFile)(process.execPath, ['scripts/benchmarks/gateway-load-test.cjs'], { env })).stdout)
    assert.equal(success.offered, 150); assert.equal(success.distinctTokens, 150); assert.equal(success.dropped, 0); assert.equal(success.gatewayChain.successful, 150)
    latency = 150
    let failed
    try { await promisify(execFile)(process.execPath, ['scripts/benchmarks/gateway-load-test.cjs'], { env: { ...env, S2T_LOAD_MAX_INFLIGHT: '2' } }) } catch (error) { failed = JSON.parse(error.stdout) }
    assert.ok(failed); assert.equal(failed.offered, 150); assert.ok(failed.dropped > 0)
    console.log('PASS: 150-route open arrival scheduler, account-token validation and overload drops. Mock only; no production capacity claim.')
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
