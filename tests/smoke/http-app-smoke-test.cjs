const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { createHttpApp } = require('../../server/http/app.cjs')
const importProbe = spawnSync(process.execPath, ['-e', `
  const assert = require('node:assert/strict'), net = require('node:net');
  net.Server.prototype.listen = () => { throw Error('import bound a socket') };
  const before = ['SIGTERM','SIGINT','SIGUSR2','unhandledRejection'].map(s => process.listenerCount(s));
  const api = require(${JSON.stringify(resolve('server/index.cjs'))});
  assert.equal(typeof api.startGateway, 'function');
  assert.deepEqual(['SIGTERM','SIGINT','SIGUSR2','unhandledRejection'].map(s => process.listenerCount(s)), before);
  assert.equal(Object.keys(require.cache).some(p => /server[\\/]storage[\\/]index.cjs$/.test(p)), false);
  assert.equal(Object.keys(require.cache).some(p => p.endsWith('audio-worker-pool.cjs')), false);
`], { timeout: 3000, encoding: 'utf8' })
assert.equal(importProbe.status, 0, importProbe.stderr || importProbe.error?.message)
;(async () => {
  let draining = false, quiescing = false, opened = 0, closed = 0
  const logs = [], failures = [], contexts = []
  const send = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  const app = createHttpApp({
    handleHttpRequest: (request, response) => { if (request.url === '/api/fail') throw Error('fixture'); send(response, 200, { ok: true }) },
    send, logger: { run: (context, fn) => { contexts.push(context); fn() }, log: (...args) => logs.push(args), error: (...args) => failures.push(args) },
    newRequestId: () => 'generated-request-id', isQuiescing: () => quiescing, isDraining: () => draining,
    onRequestOpened: () => opened++, onRequestClosed: () => closed++
  })
  assert.equal(app.listening, false, 'factory leaves socket binding to bootstrap')
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.address().port}`
  try {
    let response = await fetch(url + '/api/ok', { headers: { 'x-request-id': 'valid-request-123' } })
    assert.equal(response.headers.get('x-request-id'), 'valid-request-123'); await response.json()
    response = await fetch(url + '/api/fail', { headers: { 'x-request-id': 'bad' } })
    assert.equal(response.status, 503); assert.equal(response.headers.get('x-request-id'), 'generated-request-id'); await response.json()
    assert.equal(failures.length, 1)
    quiescing = true
    response = await fetch(url + '/api/ok'); assert.equal(response.status, 200); assert.equal(response.headers.get('connection'), 'close'); await response.json()
    draining = true
    response = await fetch(url + '/api/ok'); assert.equal(response.status, 503); await response.json()
    response = await fetch(url + '/livez'); assert.equal(response.status, 200); await response.json()
    response = await fetch(url + '/readyz'); assert.equal(response.status, 200); await response.json()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(opened, 6); assert.equal(closed, opened)
    assert.equal(contexts[0].requestId, 'valid-request-123')
    assert.ok(logs.some(([level, , value]) => level === 'warn' && value.status === 503))
    assert.ok(logs.some(([level, , value]) => level === 'debug' && value.status === 200 && value.path === '/api/ok'), 'high-volume successes must not flood info stdout')
    console.log('PASS side-effect-free import/factory, request IDs, sync error handling, quiescing, drain admission and request accounting')
  } finally { await new Promise(resolve => app.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
