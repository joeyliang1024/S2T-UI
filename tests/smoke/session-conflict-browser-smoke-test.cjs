// Production React hydration + IndexedDB outbox checkpoints, with a CAS loopback API.
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { gunzipSync } = require('node:zlib')
const { buildSync } = require('esbuild')
const { chromium, browserOptions } = require('../helpers/browser.cjs')

const fixture = (title) => ({
  id: 'fixture-session', title, createdAt: '2026-10-14T00:00:00.000Z', durationMs: 1_000,
  source: 'fixture', transcript: title, segments: [], audioKey: 'fixture-session', audioUnavailable: false,
  processingState: 'completed'
})

;(async () => {
  const outboxCode = buildSync({
    entryPoints: ['frontend/src/features/sessions/services/session-outbox.ts'],
    bundle: true, format: 'iife', globalName: 'Outbox', platform: 'browser', write: false
  }).outputFiles[0].text
  const root = path.resolve('out/web')
  let sessions = [fixture('remote first choice')], version = 1, saves = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/seed') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>Session conflict seed</title>') }
      let file = path.join(root, url.pathname)
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end() }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
      res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
      return res.end(fs.readFileSync(file))
    }
    const reply = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    let bytes = Buffer.alloc(0)
    for await (const part of req) bytes = Buffer.concat([bytes, part])
    if (req.headers['content-encoding'] === 'gzip' && bytes.length) bytes = gunzipSync(bytes)
    const body = bytes.length ? JSON.parse(bytes.toString()) : {}
    if (url.pathname === '/api/auth/session') return reply({ user: { id: 'fixture-user', username: 'fixture', role: 'user', NT: 'fixture', Department: 'test', createdAt: '2026-10-14' } })
    if (url.pathname === '/api/config') return reply({ asr: { configured: false }, translation: { configured: false }, summary: { configured: false }, diarization: { configured: false }, asrProfiles: [] })
    if (url.pathname === '/api/data/sessions') {
      if (req.method === 'GET') return reply({ sessions, version })
      saves++
      if (body.version !== version) return reply({ error: 'HTTP 409' }, 409)
      sessions = body.sessions
      return reply({ version: ++version })
    }
    if (url.pathname === '/api/data/settings') return reply(req.method === 'POST' ? { version: 1 } : { settings: { uiLanguage: 'en' }, version: 0 })
    if (url.pathname === '/api/data/summary-templates') return reply({ templates: [], selectedTemplateId: undefined, version: 0 })
    if (url.pathname === '/api/data/model-registry') return reply({ models: [], version: 0 })
    if (url.pathname === '/api/data/voiceprints') return reply({ voiceprints: [] })
    if (url.pathname === '/api/data/storage-status') return reply({ audioPending: 0, voiceprintPending: 0 })
    if (url.pathname === '/api/data/live-draft') return reply({})
    if (url.pathname === '/api/data/import-checkpoint') return reply({})
    if (url.pathname === '/api/data/storage-health') return reply({})
    if (url.pathname.startsWith('/api/data/audio/')) return reply({}, req.method === 'GET' ? 404 : 200)
    return reply({})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch(browserOptions())
  const page = await browser.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const seed = async (baseline, local) => {
    await page.goto(origin + '/seed')
    await page.addScriptTag({ content: outboxCode })
    await page.evaluate(async ({ baseline, local }) => {
      const outbox = Outbox.createSessionOutbox('fixture-user')
      await outbox.save({ baseline, local })
      await outbox.close()
    }, { baseline, local })
  }
  const checkpoint = async () => {
    await page.addScriptTag({ content: outboxCode })
    return page.evaluate(async () => {
      const outbox = Outbox.createSessionOutbox('fixture-user')
      const snapshot = await outbox.read()
      await outbox.close()
      return snapshot
    })
  }
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Preferences' }).click()
    await page.getByRole('button', { name: 'App' }).click()
    await page.getByRole('region', { name: 'Recording sync conflicts' }).waitFor()
  }
  try {
    // A remote choice accepts the server version, persists it, and consumes only its matching checkpoint after CAS ACK.
    await seed([fixture('baseline first choice')], [fixture('local first choice')])
    await page.goto(origin + '/history')
    await openSettings()
    const firstConflict = page.getByRole('region', { name: 'Recording sync conflicts' })
    await assertEventually(async () => (await firstConflict.innerText()).includes('remote first choice'), 'first divergent remote preview')
    assert.deepEqual((await checkpoint()).local.map(row => row.title), ['local first choice'], 'unresolved conflict must retain its outbox checkpoint')
    await firstConflict.getByRole('button', { name: 'Keep remote version' }).click()
    await firstConflict.waitFor({ state: 'detached' })
    await assertEventually(async () => (await checkpoint()) === undefined, 'remote choice matching ACK clears checkpoint')
    assert.deepEqual(sessions.map(row => row.title), ['remote first choice'])
    await page.reload()
    await page.getByRole('button', { name: 'Preferences' }).click()
    await page.getByRole('button', { name: 'App' }).click()
    assert.equal(await page.getByRole('region', { name: 'Recording sync conflicts' }).count(), 0, 'resolved remote choice survives reload without conflict')

    // The visible old remote must not authorize overwriting a newer remote revision.
    const baseline = [fixture('baseline second choice')], local = [fixture('local second choice')]
    sessions = [fixture('remote before local choice')]; version++
    await seed(baseline, local)
    await page.goto(origin + '/history')
    await openSettings()
    const secondConflict = page.getByRole('region', { name: 'Recording sync conflicts' })
    await assertEventually(async () => (await secondConflict.innerText()).includes('remote before local choice'), 'second divergent remote preview')
    sessions = [fixture('remote changed during local choice')]; version++
    const savesBeforeSecondDecision = saves
    await secondConflict.getByRole('button', { name: 'Keep local version' }).click()
    await assertEventually(async () => (await secondConflict.innerText()).includes('remote changed during local choice'), 'newer remote requires another conflict decision')
    assert.equal(saves, savesBeforeSecondDecision, 'first local choice must not overwrite a newer remote version')
    assert.deepEqual((await checkpoint()).local.map(row => row.title), ['local second choice'], 'new conflict keeps the local checkpoint before matching ACK')
    await secondConflict.getByRole('button', { name: 'Keep local version' }).click()
    await secondConflict.waitFor({ state: 'detached' })
    await assertEventually(async () => (await checkpoint()) === undefined, 'second explicit local choice clears only after matching ACK')
    assert.deepEqual(sessions.map(row => row.title), ['local second choice'])
    assert.equal(saves, savesBeforeSecondDecision + 1, 'only the second explicit choice writes the local version')
    assert.deepEqual(errors, [])
    console.log('PASS real React conflict UI: remote resolution survives reload; newer remote revision re-conflicts, requires a second local choice, and retains IndexedDB outbox until matching ACK')
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })

async function assertEventually(check, label) {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(label)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
