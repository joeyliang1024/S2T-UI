// Real React/Vite frontend + Python backend. No Node business API is started.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { createServer } = require('node:net')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
const { python } = require('../../scripts/runtime.cjs')

const port = async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
const ready = async (url, process, logs) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (process.exitCode !== null) throw Error(logs())
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error(`Service not ready: ${logs()}`)
}

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-python-browser-'))
  const apiPort = await port(), webPort = await port()
  const root = resolve(__dirname, '../..')
  const children = []
  let browser, page, output = ''
  const start = (executable, args, env) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    child.stdout.on('data', value => { output += value })
    child.stderr.on('data', value => { output += value })
    return child
  }
  try {
    const api = start(python(), ['-m', 'app'], {
      PATH: process.env.PATH, PYTHONPATH: join(root, 'backend'), PYTHON_DOTENV_DISABLED: '1',
      S2T_BIND_HOST: '127.0.0.1', BACKEND_PORT: String(apiPort), S2T_PROCESS_ROLE: 'api',
      S2T_DATA_DIR: directory, S2T_MODEL_DIR: join(directory, 'models'),
      S2T_AUTH_SECRET: 'isolated-browser-test-secret-123456789', S2T_ALLOW_DEFAULT_ADMIN: 'true'
    })
    await ready(`http://127.0.0.1:${apiPort}/readyz`, api, () => output)
    const web = start(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', 'config/vite.web.config.ts', '--port', String(webPort), '--strictPort'], { ...process.env, S2T_DEV_API_URL: `http://127.0.0.1:${apiPort}` })
    const base = `http://127.0.0.1:${webPort}`
    await ready(base, web, () => output)
    browser = await chromium.launch(browserOptions())
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
    const errors = [], badResponses = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 500) badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`) })
    await page.goto(base)
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.locator('.auth-card button.primary').click()
    await page.locator('.sidebar-nav').first().waitFor({ state: 'attached', timeout: 20000 })
    const auth = await page.request.get(`${base}/api/auth/session`)
    assert.equal(auth.status(), 200)
    assert.equal((await auth.json()).user.role, 'admin')
    for (const view of ['history', 'models', 'settings']) {
      await page.locator(`.sidebar-nav [data-view="${view}"]`).click()
      await page.waitForTimeout(300)
    }
    const templates = await page.request.get(`${base}/api/data/summary-templates`)
    assert.equal(templates.status(), 200)
    assert.ok((await templates.json()).templates.length)
    await page.reload()
    await page.locator('.sidebar-nav').first().waitFor({ state: 'attached' })
    assert.deepEqual(errors, [])
    assert.deepEqual(badResponses, [])
    console.log('PASS React login, cookie persistence, history/models/settings navigation and shared templates against the independent Python API')
  } catch (error) {
    if (page) {
      console.error((await page.locator('body').innerText()).slice(0, 2500))
      await page.screenshot({ path: '/private/tmp/s2t-python-web-error.png' })
    }
    console.error(output.slice(-5000))
    throw error
  } finally {
    await browser?.close()
    for (const child of children.reverse()) {
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill('SIGTERM')
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
