// Real React UI with isolated in-memory API fixtures; never calls model services.
const assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
;(async () => {
  const root = path.resolve('out/web')
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://test'); let file = path.join(root, url.pathname)
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end() }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch(browserOptions())
  const sessions = [
    { id: 'failed', title: '', createdAt: '2026-10-08T00:00:00Z', durationMs: 1000, source: 'fixture', transcript: '', audioKey: 'fixture', processingState: 'failed', processingError: 'Translation fixture failure', diarizationJobId: 'old-failed-job', processingFailures: ['translation'], segments: [{ id: 'segment', status: 'final', revision: 1, startMs: 0, endMs: 1000, sourceText: 'Meeting decision: ship tomorrow.', translationStatus: 'failed' }] },
    { id: 'legacy', title: 'Legacy failure', createdAt: '2026-10-08T00:00:00Z', durationMs: 1000, source: 'fixture', transcript: 'Legacy transcript', audioKey: 'legacy', processingState: 'failed', processingError: 'Legacy error', segments: [] },
    { id: 'completed', title: 'Completed recording', createdAt: '2026-10-08T00:00:00Z', durationMs: 1000, source: 'fixture', transcript: 'Completed meeting transcript', audioKey: 'complete', processingState: 'completed', segments: [] },
    { id: 'interrupted', title: 'Interrupted summary', createdAt: '2026-10-08T00:00:00Z', durationMs: 1000, source: 'fixture', transcript: 'Recover this transcript', audioKey: 'interrupted', processingState: 'completed', segments: [], summary: '正在產生摘要…' }
  ]
  const fileTemplate = { id: 'file-summary-fixture', name: 'File default', content: '# File baseline', sourceFile: 'fixture.md' }
  let templates = [{ id: 'base', name: 'Base', content: '# Summary' }], selectedTemplateId = 'base', templateVersion = 0, sessionVersion = 0, failSummary = true, failTranslation = true, jobPollCalls = 0, calls = 0, translatedCalls = 0, asrCalls = 0, diarizationCalls = 0
  const errors = []
  try {
    const page = await browser.newPage(); await page.emulateMedia({ colorScheme: 'dark' }); page.on('pageerror', e => errors.push(e.message))
    await page.route('**/api/**', async route => {
      const req = route.request(), pathname = new URL(req.url()).pathname; const post = req.method() === 'POST'; const body = post && req.postData() ? JSON.parse(req.postData()) : {}
      let response = {}, status = 200
      if (pathname === '/api/auth/session') response = { user: { id: 'fixture-user', username: 'fixture', role: 'user', NT: 'fixture', Department: 'test', createdAt: '2026-10-08' } }
      else if (pathname === '/api/config') response = { asr: { configured: true, endpoint: '/api/transcriptions', model: 'mock' }, asrProfiles: [], translation: { configured: true, endpoint: '/api/translations', model: 'mock-translation' }, summary: { configured: true, endpoint: '/api/summaries', model: 'mock-summary' }, diarization: { configured: false } }
      else if (pathname === '/api/data/settings') response = post ? { version: 1 } : { settings: { uiLanguage: 'en' }, version: 0 }
      else if (pathname === '/api/data/summary-templates') {
        if (post) { assert.equal(body.version, templateVersion, 'template writes use latest committed version'); await new Promise(r => setTimeout(r, 600)); templates = body.templates; selectedTemplateId = body.selectedTemplateId; templateVersion++; response = { version: templateVersion } }
        else response = { templates: [fileTemplate, ...templates], selectedTemplateId, version: templateVersion }
      } else if (pathname === '/api/data/sessions') {
        if (post) { sessions.splice(0, sessions.length, ...body.sessions); response = { version: ++sessionVersion } }
        else response = { sessions, version: sessionVersion }
      } else if (pathname === '/api/data/model-registry') response = { models: [], version: 0 }
      else if (pathname === '/api/data/voiceprints') response = { voiceprints: [] }
      else if (pathname === '/api/translations') { translatedCalls++; await new Promise(r => setTimeout(r, 250)); if (failTranslation) { status = 503; response = { error: 'Recovery fixture failure' } } else response = { text: 'Recovered translation' } }
      else if (pathname === '/api/data/diarization-jobs') { jobPollCalls++; response = { job: { state: 'failed', error: 'Old job failure' } } }
      else if (pathname === '/api/transcriptions') { asrCalls++; response = { text: 'Unexpected ASR retry' } }
      else if (pathname === '/api/diarizations') { diarizationCalls++; response = { exclusive_diarization: [{ start: 0, end: 1, speaker: 'fixture' }] } }
      else if (pathname === '/api/summaries') { calls++; if (failSummary) { status = 502; response = { error: 'Mock summary unavailable' } } else if (body.stream) { return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: [JSON.stringify({delta:'# Recovered summary'}), JSON.stringify({delta:'\nDecision: ship tomorrow.'}), JSON.stringify({done:true})].join('\n') + '\n' }) } else { assert.equal(body.singleAttempt, true); response = { text: 'Generated title' } } }
      else if (pathname === '/api/data/storage-status') response = { audioPending: 0, voiceprintPending: 0 }
      else if (pathname === '/api/data/storage-audit') response = { orphanAudio: 0 }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) })
    })
    await page.goto(origin + '/summary'); await page.locator('.summary-setup').waitFor()
    await page.waitForTimeout(500) // first slow template save is already in flight
    const selects = page.locator('.summary-setup select')
    assert.equal(await selects.nth(1).locator('option[value="custom"]').count(), 0, 'summary only selects saved templates')
    assert.equal(await page.locator('.summary-template-editor').count(), 0)
    await page.locator('.summary-setup button.secondary').click()
    await page.locator('.summary-template-manager').waitFor() // Manage templates opens its settings category directly
    await page.locator('.summary-template-manager .summary-template-list > button.secondary').click()
    await page.locator('.summary-template-editor button.primary').click() // blank validation stays in UI
    assert.equal(await page.locator('.summary-template-editor').count(), 1)
    await page.locator('.summary-template-editor input').fill('Custom persisted')
    await page.locator('.summary-template-editor textarea').fill('# Custom\n## Decisions')
    await page.locator('.summary-template-editor button.primary').click()
    await page.waitForTimeout(1600)
    assert.ok(templates.some(t => t.name === 'Custom persisted'))
    const createdId = templates.find(t => t.name === 'Custom persisted').id
    await page.locator('.summary-template-editor input').fill('Custom edited')
    await page.locator('.summary-template-editor textarea').fill('# Edited\n## Decisions')
    await page.locator('.summary-template-editor button.primary').click()
    await page.waitForTimeout(1600)
    assert.equal(templates.length, 2)
    assert.equal(templates.find(t => t.name === 'Custom edited').id, createdId, 'editing preserves template identity')
    await page.screenshot({ path: '/tmp/s2t-template-settings.png', fullPage: false })
    await page.locator('.saved-template-list button').filter({ hasText: 'File default' }).click()
    await page.getByRole('button', { name: 'Save as personal template', exact: true }).waitFor()
    await page.locator('.summary-template-editor textarea').fill('# Private copy')
    await page.locator('.summary-template-editor button.primary').click(); await page.waitForTimeout(1600)
    assert.equal(fileTemplate.content, '# File baseline'); assert.equal(templates.length, 3); assert.ok(templates.some(t => t.content === '# Private copy' && !t.sourceFile));
    await page.locator('.saved-template-list button').filter({ hasText: 'Custom edited' }).click(); await page.waitForTimeout(1600)
    await page.goto(origin + '/summary'); await page.locator('.summary-setup').waitFor()
    await selects.nth(1).getByText('Custom edited', { exact: true }).waitFor({ state: 'attached' })
    await selects.nth(0).selectOption('failed')
    assert.equal(await page.locator('.summary-setup button.primary').isEnabled(), true)
    await page.locator('.summary-setup button.primary').click()
    await page.getByRole('alert').filter({ hasText: 'Mock summary unavailable' }).waitFor().catch(async error => { console.error(JSON.stringify({ calls, errors, body: await page.locator('body').innerText() })); throw error })
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
    await page.goto(origin + '/history'); await page.locator('.session-actions').first().waitFor()
    const failedCard = page.locator('.session-details').filter({ has: page.getByRole('button', { name: /^Recording title:\s*$/, exact: true }) })
    await failedCard.getByText('Untitled record', { exact: true }).waitFor()
    const titleButton = failedCard.getByRole('button', { name: 'Generate title', exact: true })
    failSummary = true; const beforeTitle = calls
    await titleButton.click(); await page.waitForTimeout(1500)
    assert.equal(calls, beforeTitle + 1); await failedCard.getByText('Untitled record', { exact: true }).waitFor()
    failSummary = false; await titleButton.click(); await page.waitForTimeout(1000)
    assert.equal(calls, beforeTitle + 2); assert.equal(await page.getByText('Untitled record', { exact: true }).count(), 0)
    assert.equal(await page.locator('.summary-stale').count(), 0)
    const legacyCard = page.locator('.session-item').filter({ hasText: 'Legacy failure' })
    const beforeLegacy = translatedCalls
    await legacyCard.getByRole('button', { name: 'Error recovery: retry failed steps', exact: true }).click()
    await page.getByRole('region', { name: 'Choose recovery action' }).waitFor()
    assert.equal(translatedCalls, beforeLegacy, 'opening choices does not invoke a model')
    failTranslation = false
    await page.getByRole('button', { name: 'Translate transcript again', exact: true }).click()
    await page.waitForTimeout(900)
    assert.equal(translatedCalls, beforeLegacy + 1); assert.equal(asrCalls, 0)
    failTranslation = true; translatedCalls = 0
    const recovery = page.getByRole('button', { name: 'Error recovery: retry failed steps', exact: true })
    await recovery.hover(); await page.getByRole('tooltip').filter({ hasText: 'Error recovery: retry failed steps' }).waitFor()
    const rectangles = []
    for (let index = 0; index < 4; index++) { rectangles.push(await recovery.boundingBox()); await page.waitForTimeout(100) }
    assert.ok(Math.abs(rectangles[3].y - rectangles[2].y) < .1, 'record layout settles before interaction')
    await recovery.click(); await page.waitForTimeout(3500)
    assert.equal(translatedCalls, 1, 'one click remains one attempt after failure'); assert.equal(jobPollCalls, 0, 'manual recovery never polls the old failed job');
    await recovery.click(); await page.waitForTimeout(3500); assert.equal(translatedCalls, 2, 'a second click starts exactly one new attempt');
    failTranslation = false
    await page.evaluate(() => {
      window.__storageDuringProcessing = []
      window.__storageObserver = new MutationObserver(() => {
        for (const item of document.querySelectorAll('.session-item')) {
          if (item.querySelector('.session-processing-state.running')) window.__storageDuringProcessing.push(item.querySelector('.session-storage-state')?.textContent)
        }
      })
      window.__storageObserver.observe(document.querySelector('.session-list'), { subtree: true, childList: true, characterData: true, attributes: true })
    })
    await recovery.click(); await page.waitForTimeout(900)
    const storageDuringProcessing = await page.evaluate(() => { window.__storageObserver.disconnect(); return window.__storageDuringProcessing })
    assert.ok(storageDuringProcessing.length > 0)
    assert.ok(storageDuringProcessing.every(value => value === 'Local, pending sync'), 'running badges never alternate between pending and both')

    assert.equal(translatedCalls, 3); assert.equal(asrCalls, 0); assert.equal(diarizationCalls, 0)
    assert.equal(await page.getByRole('button', { name: 'Error recovery: retry failed steps', exact: true }).count(), 0)
    assert.equal(await page.locator('.session-actions > button').filter({ hasText: 'Quality correction' }).count(), 0, 'quality correction stays inside More actions')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ storageBadgeStableWhileProcessing: true, legacyRecordRecoverySelectable: true, manualTitleGenerationAndFailure: true, streamedSummaryRendered: true, noStaleWarning: true, customTemplateSavedAndReloaded: true, fileTemplateEditsCreatePersonalCopy: true, templateEditingOnlyInSettings: true, templateEditPreservesIdentity: true, recoveryOnlyRetriesFailedTranslation: true, recoveryIconHasTooltip: true, failedRecoveryStopsUntilNextClick: true, oldJobNotPolledDuringRecovery: true, blankNameDoesNotCrash: true, failedRecordingCanSummarize: true, summaryFailureThenRetry: true, failedRegenerationPreservesPrevious: true, completedCanSummarize: true, interruptedSummaryRecoverable: true, pageErrors: errors }))
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(e => { console.error(e); process.exitCode = 1 })
