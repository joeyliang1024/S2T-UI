const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const directory = mkdtempSync(join(tmpdir(), 's2t-bootstrap-life-'))
try {
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const before = ['SIGTERM','SIGINT','SIGUSR2','unhandledRejection'].map(s => process.listenerCount(s));
    const runtime = require(${JSON.stringify(resolve('server/index.cjs'))}).startGateway();
    assert.deepEqual(['SIGTERM','SIGINT','SIGUSR2','unhandledRejection'].map(s => process.listenerCount(s)), before);
    (async () => {
      if (!runtime.server.listening) await new Promise(resolve => runtime.server.once('listening', resolve));
      const root = 'http://127.0.0.1:' + runtime.server.address().port;
      const health = await fetch(root + '/readyz'); assert.equal(health.status, 200); await health.text();
      runtime.prepareForShutdown();
      const notReady = await fetch(root + '/readyz'); assert.equal(notReady.status, 503); await notReady.text();
      const first = runtime.stop(); assert.equal(runtime.stop(), first, 'stop must be idempotent');
      await first; assert.equal(runtime.server.listening, false);
      console.log('STOP_RETURNED_WITHOUT_EXIT');
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `], { cwd: directory, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, S2T_WEB_PORT: '0', S2T_PROCESS_ROLE: 'api', S2T_LOCAL_DATA_DIR: directory, S2T_ALLOW_DEFAULT_ADMIN: 'true', S2T_AUTH_SECRET: 'isolated-bootstrap-lifecycle-secret', S2T_LOG_LEVEL: 'silent' } })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  assert.match(child.stdout, /STOP_RETURNED_WITHOUT_EXIT/)
  console.log('PASS explicit bootstrap, readiness withdrawal, idempotent awaitable stop, no signal installation or host exit, natural resource release')
} finally { rmSync(directory, { recursive: true, force: true }) }
