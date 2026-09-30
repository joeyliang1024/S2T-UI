// Gateway startup regression smoke for shared storage.
//
// In PostgreSQL mode the gateway used to race two async startups: the schema
// migration (PostgresConfigStore.migrate) and the auth bootstrap
// (createAuth -> ensureBootstrapAdmin). The bootstrap SELECT usually reached
// Postgres before CREATE TABLE, so createAuth rejected and the first real API
// request crashed the whole process with an unhandled rejection.
//
// This test boots server/index.cjs against a throwaway database and asserts
// that liveness, readiness, storage status and an authenticated API route all
// work while the process stays alive. Requires a reachable PostgreSQL
// (same environment as storage:remote:smoke).
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const dotenv = require('dotenv')
const { Client } = require('pg')

dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })

const port = Number(process.env.S2T_STARTUP_SMOKE_PORT || 8796)
const base = `http://127.0.0.1:${port}`
const database = 's2t_startup_smoke'
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const postgresEnvironment = () => {
  const names = ['S2T_POSTGRES_HOST', 'S2T_POSTGRES_PORT', 'S2T_POSTGRES_DB_NAME', 'S2T_POSTGRES_USER', 'S2T_POSTGRES_PASSWORD']
  const missing = names.filter((name) => !process.env[name]?.trim())
  assert.equal(missing.length, 0, `storage:gateway:smoke 需要 PostgreSQL 環境變數，缺少：${missing.join(', ')}`)
  return Object.fromEntries(names.map((name) => [name, process.env[name].trim()]))
}

const adminClient = (credentials) => new Client({
  host: credentials.S2T_POSTGRES_HOST,
  port: Number(credentials.S2T_POSTGRES_PORT),
  user: credentials.S2T_POSTGRES_USER,
  password: credentials.S2T_POSTGRES_PASSWORD,
  database: 'postgres'
})

const probe = async (path, options = {}) => {
  try {
    const response = await fetch(`${base}${path}`, options)
    const text = await response.text()
    let body = text
    try { body = JSON.parse(text) } catch { /* keep raw text */ }
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, body: { error: error instanceof Error ? error.message : 'request failed' } }
  }
}

const waitForLiveness = async (child) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) return false
    const result = await probe('/livez')
    if (result.status === 200) return true
    await delay(250)
  }
  return false
}

const main = async () => {
  const credentials = postgresEnvironment()
  const admin = adminClient(credentials)
  const dataDirectory = await mkdtemp(join(tmpdir(), 's2t-startup-smoke-'))
  let child = null
  try {
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${database}`)
    await admin.query(`CREATE DATABASE ${database}`)

    child = spawn(process.execPath, ['server/index.cjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...credentials,
        S2T_POSTGRES_DB_NAME: database,
        S2T_AUTH_SECRET: `startup-smoke-${randomUUID()}`,
        S2T_BOOTSTRAP_ADMIN_USERNAME: 'startup-smoke-admin',
        S2T_BOOTSTRAP_ADMIN_PASSWORD: 'startup-smoke-password',
        S2T_WEB_PORT: String(port),
        S2T_WEB_ORIGINS: 'http://127.0.0.1:5173',
        S2T_LOCAL_DATA_DIR: dataDirectory,
        S2T_MINIO_ENDPOINT: '', S2T_MINIO_BUCKET: '', S2T_MINIO_ACCESS_KEY: '', S2T_MINIO_SECRET_KEY: '',
        S2T_MILVUS_ENDPOINT: '', S2T_MILVUS_DB_NAME: '', S2T_MILVUS_COLLECTION: '', S2T_MILVUS_TOKEN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const exitState = { value: null }
    child.on('exit', (code, signal) => { exitState.value = { code, signal } })

    assert.equal(await waitForLiveness(child), true, `gateway 沒有啟動：\n${output}`)
    assert.equal(exitState.value, null, `gateway 在通過 liveness 前就退出了：\n${output}`)

    // The migration and the auth bootstrap used to race here.
    const ready = await probe('/readyz')
    assert.equal(ready.status, 200, `readyz 應代表 storage 與 auth 都已就緒：${JSON.stringify(ready.body)}\n${output}`)

    const storage = await probe('/api/storage')
    assert.equal(storage.status, 200, `storage 狀態應可讀取：${JSON.stringify(storage.body)}`)
    assert.equal(storage.body.ready, true)
    assert.equal(storage.body.mode.config, 'postgres')

    // A real API request must not crash the process (authReady rejection used
    // to surface here as an unhandled rejection and exit the gateway).
    const session = await probe('/api/auth/session')
    assert.equal(session.status, 401, '未登入時 session 應回 401')

    const registration = await probe('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `startup-${randomUUID().replace(/-/g, '').slice(0, 12)}`, password: 'startup-smoke-password', NT: `Startup ${randomUUID().slice(0, 8)}`, Department: 'Storage smoke' })
    })
    assert.equal(registration.status, 201, `註冊失敗：${JSON.stringify(registration.body)}`)

    const settings = await probe('/api/data/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${registration.body.token}` },
      body: JSON.stringify({ settings: { theme: 'system' }, version: 0 })
    })
    assert.equal(settings.status, 200, `storage 寫入失敗：${JSON.stringify(settings.body)}`)

    assert.equal(exitState.value, null, `gateway 在 API 呼叫期間退出：${JSON.stringify(exitState.value)}\n${output}`)
    console.log('Gateway storage startup smoke test passed.')
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    await delay(250)
    try {
      const cleanup = adminClient(credentials)
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      await cleanup.end()
    } catch (error) {
      console.error(`清理暫存資料庫失敗：${error instanceof Error ? error.message : error}`)
    }
    await admin.end().catch(() => undefined)
    await rm(dataDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
