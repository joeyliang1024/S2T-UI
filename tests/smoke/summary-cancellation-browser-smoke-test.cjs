const assert = require('node:assert/strict')
const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const { chromium, browserOptions } = require('../helpers/browser.cjs')

;(async () => {
  const root = path.resolve('out/web')
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'); let file = path.join(root, url.pathname)
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end()
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch(browserOptions())
  const pending = [], errors = [], translationPending = []
  let translationMode = 'success'
  let user = 'fixture-user', version = 0
  const rows = () => user === 'other-user'
    ? [{ id: 'other', title: 'Other account', createdAt: '2026-10-17T00:00:00Z', durationMs: 1, source: 'fixture', transcript: 'other transcript', audioKey: 'other', segments: [] }]
    : [
      { id: 'new', title: 'New summary', createdAt: '2026-10-17T00:00:00Z', durationMs: 1, source: 'fixture', transcript: 'new transcript', audioKey: 'new', segments: [] },
      { id: 'old', title: 'Existing summary', createdAt: '2026-10-17T00:00:00Z', durationMs: 1, source: 'fixture', transcript: 'old transcript', audioKey: 'old', segments: [], summary: '  # Previous summary\n  ', summaryTranslation: '# Previous translation', summaryTranslationTargetLanguage: 'ja' }
    ]
  try {
    const page = await browser.newPage(); await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin}); page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname
      const body = request.postData() ? JSON.parse(request.postData()) : {}
      if (pathname === '/api/summaries') { pending.push(route); return }
      let response = {}, status = 200
      if (pathname === '/api/auth/session') response = { user: { id: user, username: user, role: 'user', NT: user, Department: 'fixture', createdAt: '2026-10-17' } }
      else if (pathname === '/api/config') response = { asr: { configured: true, endpoint: '/api/transcriptions', model: 'mock' }, asrProfiles: [], translation: { configured: true, endpoint: '/api/translations', model: 'mock' }, summary: { configured: true, endpoint: '/api/summaries', model: 'mock' }, diarization: { configured: false } }
      else if (pathname === '/api/data/settings') response = request.method() === 'POST' ? { version: 1 } : { settings: { uiLanguage: 'en', targetLanguage: 'ja' }, version: 0 }
      else if (pathname === '/api/data/sessions') { if (request.method() === 'POST') { version += 1; response = { version } } else response = { sessions: rows(), version } }
      else if (pathname === '/api/data/summary-templates') response = { templates: [{ id: 'base', name: 'Base', content: '# Summary' }], selectedTemplateId: 'base', version: 0 }
      else if (pathname === '/api/data/model-registry') response = { models: [], version: 0 }
      else if (pathname === '/api/data/voiceprints') response = { voiceprints: [] }
      else if (pathname === '/api/data/storage-status') response = { audioPending: 0, voiceprintPending: 0 }
      else if (pathname === '/api/data/storage-audit') response = { orphanAudio: 0 }
      else if (pathname === '/api/translations') { if (translationMode === 'pending') { translationPending.push(route); return } if (translationMode === 'error') { status=503; response={error:'Translation fixture unavailable'} } else response = { text: '# Fresh translated summary' } }
      else if (pathname === '/api/transcriptions') response = { text: 'unused' }
      else response = {}
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) })
    })
    await page.goto(origin + '/summary'); await page.locator('.summary-setup').waitFor()
    const select = page.locator('.summary-setup select').first()
    await select.selectOption('new')
    await page.getByRole('tab', { name: 'Translate summary', exact: true }).click()
    await page.locator('.summary-target-language select').selectOption('de')
    assert.equal(pending.length, 0, 'choosing a tab and target does not generate')
    await page.getByRole('button', { name: 'Generate summary', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel generation', exact: true }).waitFor()
    const translated = pending.shift()
    assert.match(JSON.stringify(translated.request().postDataJSON()), /German/)
    await translated.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ delta: '# German summary' })}\n${JSON.stringify({ done: true })}\n` })
    await page.getByRole('heading', { name: 'German summary', exact: true }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Translate summary', exact: true }).getAttribute('aria-selected'), 'true')
    await page.getByRole('tab', { name: 'Original text', exact: true }).click()
    assert.equal(await page.getByRole('heading', { name: 'German summary', exact: true }).count(), 0, 'translated generation does not overwrite original')
    await page.getByRole('button', { name: 'Generate summary', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel generation', exact: true }).waitFor()
    assert.equal(pending.length, 1)
    await page.getByRole('button', { name: 'Cancel generation', exact: true }).click()
    await page.getByRole('button', { name: 'Generate summary', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Generate summary', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel generation', exact: true }).waitFor()
    assert.equal(pending.length, 2, 'a cancellation permits an immediate new generation')
    await pending.shift().fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ delta: '# Late new summary' })}\n${JSON.stringify({ done: true })}\n` })
    await page.waitForTimeout(100)
    assert.equal(await page.getByRole('heading', { name: 'Late new summary', exact: true }).count(), 0, 'late result after cancel cannot create a summary')
    assert.equal(await page.getByRole('button', { name: 'Cancel generation', exact: true }).count(), 1, 'the old finally cannot clear the replacement generation')
    await pending.shift().fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ delta: '# Fresh new summary' })}\n${JSON.stringify({ done: true })}\n` })
    await page.getByRole('heading', { name: 'Fresh new summary', exact: true }).waitFor()

    await select.selectOption('old'); await page.getByRole('button', { name: 'Generate summary', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel generation', exact: true }).click()
    await pending.shift().fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ delta: '# Late replacement' })}\n${JSON.stringify({ done: true })}\n` })
    await page.getByRole('heading', { name: 'Previous summary', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Translate summary', exact: true }).click()
    await page.getByText('Previous translation', { exact: true }).waitFor()

    await page.locator('.summary-target-language select').selectOption('de')
    translationMode = 'error'
    await page.getByRole('button',{name:'Generate summary',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Translation fixture unavailable'}).waitFor()
    translationMode = 'pending'
    await page.getByRole('button',{name:'Generate summary',exact:true}).click()
    await page.getByRole('button',{name:'Cancel generation',exact:true}).waitFor()
    await page.getByRole('tab',{name:'Original text',exact:true}).click()
    await page.getByRole('heading',{name:'Previous summary',exact:true}).waitFor()
    assert.equal(await page.locator('.summary-result').getByText('Translating summary…',{exact:true}).count(),0,'translation status must not hide the original')
    await page.getByRole('button',{name:'Cancel generation',exact:true}).click()
    await translationPending.shift().fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'Late cancelled translation'})}).catch(()=>{})
    await page.getByRole('tab',{name:'Translate summary',exact:true}).click()
    await page.locator('.summary-target-language select').selectOption('ja')
    await page.getByText('Previous translation',{exact:true}).waitFor()
    await page.locator('.summary-target-language select').selectOption('de')
    await page.getByRole('button',{name:'Generate summary',exact:true}).click()
    await page.getByRole('button',{name:'Cancel generation',exact:true}).waitFor()
    await select.selectOption('new')
    await translationPending.shift().fulfill({status:200,contentType:'application/json',body:JSON.stringify({text:'Wrong session translation'})}).catch(()=>{})
    assert.equal(await page.getByText('Wrong session translation',{exact:true}).count(),0)
    translationMode = 'success'
    await select.selectOption('old')
    await page.getByRole('tab',{name:'Translate summary',exact:true}).click()
    await page.locator('.summary-target-language select').selectOption('de')
    await page.getByRole('button',{name:'Generate summary',exact:true}).click()
    await page.getByRole('heading',{name:'Fresh translated summary',exact:true}).waitFor()
    await page.locator('.summary-actions button').first().click()
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'# Fresh translated summary')
    for(const [format,extension] of [['TXT','txt'],['MARKDOWN','md'],['DOCX','docx']]){
      await page.locator('.summary-actions button').nth(1).click()
      const downloaded = page.waitForEvent('download')
      await page.locator('.download-picker-options button').filter({has:page.locator('.download-format-badge').filter({hasText:new RegExp('^'+format+'$')})}).click()
      const file = await downloaded
      assert.ok(file.suggestedFilename().endsWith('.'+extension))
      const data = fs.readFileSync(await file.path())
      if(format==='DOCX')assert.equal(data.subarray(0,2).toString(),'PK')
      else assert.match(data.toString(),/Fresh translated summary/)
      await page.locator('.download-picker').waitFor({state:'detached'})
    }

    await page.getByRole('tab',{name:'Original text',exact:true}).click()
    await page.getByRole('heading',{name:'Previous summary',exact:true}).waitFor()

    // Reloading as another account aborts the previous page's pending request;
    // a late transport response cannot appear in the new account's sessions.
    await page.getByRole('tab', { name: 'Original text', exact: true }).click()
    await page.getByRole('button', { name: 'Generate summary', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel generation', exact: true }).waitFor()
    assert.equal(pending.length, 1, 'the account-switch case has an active provider request')
    user = 'other-user'; await page.reload(); await page.locator('.summary-setup').waitFor()
    await pending.shift().fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ delta: '# Wrong account' })}\n${JSON.stringify({ done: true })}\n` })
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('Wrong account', { exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log('PASS real summary UI cancels new/regenerated work, restores the previous summary, fences late output and survives account reload')
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
