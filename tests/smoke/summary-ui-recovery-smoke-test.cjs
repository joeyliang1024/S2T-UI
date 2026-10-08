// Real React UI with isolated in-memory API fixtures; never calls model services.
const assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const { chromium } = require('/Users/liangzhiquan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
;(async () => {
  const root = path.resolve('out/renderer')
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://test'); let file = path.join(root, url.pathname)
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end() }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const sessions = [
    { id: 'failed', title: 'Errored recording', createdAt: '2026-10-08T00:00:00Z', durationMs: 1000, source: 'fixture', transcript: '', audioKey: 'fixture', processingState: 'failed', processingError: 'Diarization fixture failure', segments: [{ id: 'segment', status: 'final', revision: 1, startMs: 0, endMs: 1000, sourceText: 'Meeting decision: ship tomorrow.' }] },
    { id: 'completed', title: 'Completed recording', createdAt: '2026-10-08T00:00:00Z', durationMs: 1000, source: 'fixture', transcript: 'Completed meeting transcript', audioKey: 'complete', processingState: 'completed', segments: [] },
    { id: 'interrupted', title: 'Interrupted summary', createdAt: '2026-10-08T00:00:00Z', durationMs: 1000, source: 'fixture', transcript: 'Recover this transcript', audioKey: 'interrupted', processingState: 'completed', segments: [], summary: '正在產生摘要…' }
  ]
  let templates = [{ id: 'base', name: 'Base', content: '# Summary' }], selectedTemplateId = 'base', templateVersion = 0, sessionVersion = 0, failSummary = true, calls = 0
  const errors = []
  try {
    const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname; const post = req.method() === 'POST'; const body = post && req.postData() ? JSON.parse(req.postData()) : {}
      let response = {}, status = 200
      if (pathname === '/api/auth/session') response = { user: { id: 'fixture-user', username: 'fixture', role: 'user', NT: 'fixture', Department: 'test', createdAt: '2026-10-08' } }
      else if (pathname === '/api/config') response = { asr: { configured: true, endpoint: '/api/transcriptions', model: 'mock' }, asrProfiles: [], translation: { configured: false }, summary: { configured: true, endpoint: '/api/summaries', model: 'mock-summary' }, diarization: { configured: false } }
      else if (pathname === '/api/data/settings') response = post ? { version: 1 } : { settings: { uiLanguage: 'en' }, version: 0 }
      else if (pathname === '/api/data/summary-templates') {
        if (post) { assert.equal(body.version, templateVersion, 'template writes use latest committed version'); await new Promise(r => setTimeout(r, 600)); templates = body.templates; selectedTemplateId = body.selectedTemplateId; templateVersion++; response = { version: templateVersion } }
        else response = { templates, selectedTemplateId, version: templateVersion }
      } else if (pathname === '/api/data/sessions') {
        if (post) { sessions.splice(0, sessions.length, ...body.sessions); response = { version: ++sessionVersion } }
        else response = { sessions, version: sessionVersion }
      } else if (pathname === '/api/data/model-registry') response = { models: [], version: 0 }
      else if (pathname === '/api/data/voiceprints') response = { voiceprints: [] }
      else if (pathname === '/api/summaries') { calls++; if (failSummary) { status = 502; response = { error: 'Mock summary unavailable' } } else response = { text: '# Recovered summary\nDecision: ship tomorrow.' } }
      else if (pathname === '/api/data/storage-status') response = { audioPending: 0, voiceprintPending: 0 }
      else if (pathname === '/api/data/storage-audit') response = { orphanAudio: 0 }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) })
    })
    await page.goto(origin + '/summary'); await page.locator('.summary-setup').waitFor()
    await page.waitForTimeout(500) // first slow template save is already in flight
    const selects = page.locator('.summary-setup select')
    await selects.nth(1).selectOption('custom')
    await page.locator('.summary-custom-template button').click() // blank validation stays in UI
    assert.equal(await page.locator('.summary-custom-template').count(), 1)
    await page.locator('.summary-custom-template input').fill('Custom persisted')
    await page.locator('.summary-custom-template textarea').fill('# Custom\n## Decisions')
    await page.locator('.summary-custom-template button').click()
    await page.waitForFunction(() => !document.querySelector('.summary-custom-template'))
    await page.waitForTimeout(1600)
    assert.ok(templates.some(t => t.name === 'Custom persisted'))
    await page.reload(); await page.locator('.summary-setup').waitFor()
    await selects.nth(1).getByText('Custom persisted', { exact: true }).waitFor({ state: 'attached' })
    await selects.nth(0).selectOption('failed')
    assert.equal(await page.locator('.summary-setup button.primary').isEnabled(), true)
    await page.locator('.summary-setup button.primary').click()
    await page.getByRole('alert').filter({ hasText: 'Mock summary unavailable' }).waitFor()
    assert.equal(await page.locator('.summary-setup button.primary').isEnabled(), true)
    failSummary = false; await page.locator('.summary-setup button.primary').click()
    await page.getByRole('heading', { name: 'Recovered summary', exact: true }).waitFor()
    assert.equal(calls, 2)
    failSummary = true; await page.locator('.summary-setup button.primary').click()
    await page.getByRole('alert').filter({ hasText: 'Mock summary unavailable' }).waitFor()
    assert.equal(await page.getByRole('heading', { name: 'Recovered summary', exact: true }).count(), 1, 'failed regeneration retains previous summary')
    failSummary = false; await page.locator('.summary-setup button.primary').click()
    await page.getByRole('heading', { name: 'Recovered summary', exact: true }).waitFor()
    await selects.nth(0).selectOption('completed'); await page.locator('.summary-setup button.primary').click(); await page.getByRole('heading', { name: 'Recovered summary', exact: true }).waitFor()
    await selects.nth(0).selectOption('interrupted'); assert.equal(await page.locator('.summary-setup button.primary').isEnabled(), true)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ customTemplateSavedAndReloaded: true, blankNameDoesNotCrash: true, failedRecordingCanSummarize: true, summaryFailureThenRetry: true, failedRegenerationPreservesPrevious: true, completedCanSummarize: true, interruptedSummaryRecoverable: true, pageErrors: errors }))
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(e => { console.error(e); process.exitCode = 1 })
