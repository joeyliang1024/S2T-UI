const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const sourceRoot = resolve(__dirname, '..', '..')
const reservePort = async () => {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => { probe.removeListener('error', reject); resolve() })
  })
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}
const waitFor = async (base, child, output) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw Error(`gateway exited before readiness: ${output()}`)
    try { if ((await fetch(`${base}/readyz`)).ok) return } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error(`gateway did not become ready: ${output()}`)
}

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-single-origin-'))
  const port = await reservePort()
  const base = `http://127.0.0.1:${port}`
  const webRoot = join(directory, 'out', 'web')
  let child
  let output = ''
  try {
    // The gateway must serve its production bundle itself.  Use a small,
    // isolated out/web fixture so this contract never depends on Vite preview
    // or a developer's generated output.
    await mkdir(webRoot, { recursive: true })
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>gateway single origin</title><main>single-origin fixture</main>')
    child = spawn(process.execPath, [join(sourceRoot, 'server', 'index.cjs')], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        S2T_MODELS_DIR: join(sourceRoot, 'models'),
        S2T_WEB_PORT: String(port),
        S2T_ALLOW_DEFAULT_ADMIN: 'true',
        S2T_AUTH_SECRET: 'single-origin-smoke-secret-only-123456789',
        S2T_KUBERNETES_MODE: 'false',
        S2T_LOCAL_DATA_DIR: join(directory, 'storage'),
        S2T_BOOTSTRAP_ADMIN_USERNAME: '', S2T_BOOTSTRAP_ADMIN_PASSWORD: '',
        S2T_MINIO_ENDPOINT: '', S2T_MINIO_BUCKET: '', S2T_MINIO_ACCESS_KEY: '', S2T_MINIO_SECRET_KEY: '',
        S2T_POSTGRES_HOST: '', S2T_POSTGRES_PORT: '', S2T_POSTGRES_DB_NAME: '', S2T_POSTGRES_USER: '', S2T_POSTGRES_PASSWORD: '',
        S2T_MILVUS_ENDPOINT: '', S2T_MILVUS_DB_NAME: '', S2T_MILVUS_COLLECTION: '', S2T_MILVUS_TOKEN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    await waitFor(base, child, () => output)

    let response = await fetch(`${base}/`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /single-origin fixture/)
    response = await fetch(`${base}/sessions/history`)
    assert.equal(response.status, 200, 'a client-side deep link must receive the same Web bundle')
    assert.match(await response.text(), /single-origin fixture/)

    response = await fetch(`${base}/api/auth/session`, { headers: { origin: base } })
    assert.equal(response.status, 401, 'the gateway serves the auth API on its own origin')
    assert.equal(response.headers.get('access-control-allow-origin'), base)

    response = await fetch(`${base}/api/auth/session`, { headers: { origin: 'http://127.0.0.1:5173' } })
    assert.equal(response.status, 403, 'the retired development-preview origin must not be allowed by default')
    console.log('PASS single gateway origin serves Web, deep links and auth while rejecting the retired preview origin')
  } finally {
    if (child?.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await rm(directory, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
