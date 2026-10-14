const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const code = buildSync({ entryPoints: ['src/renderer/src/shared/http/authenticated-client.ts'], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const load = () => { const module = { exports: {} }; new Function('module', 'exports', 'require', code)(module, module.exports, require); return module.exports }
;(async () => {
  let release, requests = 0
  global.window = { s2t: { getGatewayUrl: () => new Promise(resolve => { release = resolve }) } }
  global.fetch = async () => { requests++; return new Response('{}') }
  const first = load(); first.setAccessToken('account-a')
  const stale = first.authFetch('/api/data/sessions', { method: 'POST', body: 'private-a' })
  first.setAccessToken('account-b'); release('http://localhost:9000')
  await assert.rejects(stale, { name: 'AbortError' }); assert.equal(requests, 0)
  global.window = { setTimeout: callback => { callback(); return 1 } }
  const next = load(); next.setAccessToken('account-a')
  global.fetch = async (_url, init) => {
    requests++; assert.equal(new Headers(init.headers).get('x-custom'), 'retained')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer account-a')
    next.setAccessToken('account-b'); return new Response('{}', { status: 503 })
  }
  await assert.rejects(next.retryableAuthFetch('/api/data/sessions', { method: 'POST', headers: new Headers({ 'x-custom': 'retained' }), body: 'private-a' }), { name: 'AbortError' })
  assert.equal(requests, 1, 'old account payload must never retry with the next account credential')
  console.log('PASS account changes cancel gateway resolution and cross-account retries; standard Headers retained')
})().catch(error => { console.error(error); process.exitCode = 1 })
