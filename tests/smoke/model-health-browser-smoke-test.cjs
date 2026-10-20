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
  const pending = [], errors = [], apiTests = []
  let user = 'fixture-user', version = 0, testMode = 'healthy'
  const testPending = []
  const rows = () => user === 'other-user'
    ? [{ id: 'other', title: 'Other account', createdAt: '2026-10-17T00:00:00Z', durationMs: 1, source: 'fixture', transcript: 'other transcript', audioKey: 'other', segments: [] }]
    : [
      { id: 'new', title: 'New summary', createdAt: '2026-10-17T00:00:00Z', durationMs: 1, source: 'fixture', transcript: 'new transcript', audioKey: 'new', segments: [] },
      { id: 'old', title: 'Existing summary', createdAt: '2026-10-17T00:00:00Z', durationMs: 1, source: 'fixture', transcript: 'old transcript', audioKey: 'old', segments: [], summary: '# Previous summary', summaryTranslation: '# Previous translation', summaryTranslationTargetLanguage: 'ja' }
    ]
  try {
    const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname
      const body = request.postData() ? JSON.parse(request.postData()) : {}
      if (pathname === '/api/summaries') { pending.push(route); return }
      let response = {}, status = 200
      if (pathname === '/api/data/model-test') { apiTests.push(body); if (testMode === 'pending') { testPending.push(route); return } if (testMode === 'error') { await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture test unavailable'})}); return } await new Promise(resolve=>setTimeout(resolve,120)); response={result:{id:body.id||'manual-draft',state:'healthy',reason:'Fixture API model list check; no inference',checkedAt:Date.now(),elapsedMs:120,testKind:'model-list'}} }
      else if (pathname === '/api/data/model-health') response = { health: [{ id: 'managed-summary', state: 'unhealthy', reason: 'HTTP 401：認證失敗，請檢查 API key', checkedAt: Date.now() }] }
      else if (pathname === '/api/auth/session') response = { user: { id: user, username: user, role: 'admin', NT: user, Department: 'fixture', createdAt: '2026-10-17' } }
      else if (pathname === '/api/config') response = { asr: { configured: true, endpoint: '/api/transcriptions', model: 'mock' }, asrProfiles: [], translation: { configured: true, endpoint: '/api/translations', model: 'mock' }, summary: { configured: true, endpoint: '/api/summaries', model: 'mock' }, diarization: { configured: false }, diarizationProfiles: [{id:'local-sherpa-diarization',name:'Local speaker fixture',model:'sherpa-onnx-speaker-diarization',endpoint:'/api/diarizations',configured:true}] }
      else if (pathname === '/api/data/settings') { await new Promise(done => setTimeout(done, 250)); response = request.method() === 'POST' ? { version: 1 } : { settings: { uiLanguage: 'en', targetLanguage: 'ja', modelProfiles: [] }, version: 0 } }
      else if (pathname === '/api/data/sessions') { if (request.method() === 'POST') { version += 1; response = { version } } else response = { sessions: rows(), version } }
      else if (pathname === '/api/data/summary-templates') response = { templates: [{ id: 'base', name: 'Base', content: '# Summary' }], selectedTemplateId: 'base', version: 0 }
      else if (pathname === '/api/data/model-registry') response = request.method() === 'POST' ? { version: 1 } : { models: [{ id: 'custom-asr', purpose: 'asr', name: 'Persisted custom ASR', model: 'fixture-model', endpoint: 'http://localhost:8000/v1', requiresApiKey: false }], version: 0 }
      else if (pathname === '/api/data/voiceprints') response = { voiceprints: [] }
      else if (pathname === '/api/data/storage-status') response = { audioPending: 0, voiceprintPending: 0 }
      else if (pathname === '/api/data/storage-audit') response = { orphanAudio: 0 }
      else if (pathname === '/api/translations') response = { text: 'translation' }
      else if (pathname === '/api/transcriptions') response = { text: 'unused' }
      else response = {}
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) })
    })
    await page.goto(origin + '/models')
    const reason = page.locator('.model-health-reason').filter({ hasText: 'HTTP 401' })
    await page.getByRole('button', { name: 'Health check details: Failed', exact: true }).waitFor()
    assert.equal(await reason.isVisible(), false, 'failure details are hidden until the indicator is clicked')
    await page.getByRole('button', { name: 'Health check details: Failed', exact: true }).click()
    await page.getByRole('dialog', { name: 'Health check details', exact: true }).waitFor()
    assert.ok(await reason.isVisible())
    assert.equal(await page.locator('.model-dialog').count(), 0, 'indicator click must not open model editing')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const box = await reason.boundingBox()
      assert.ok(box.width > 0 && box.x >= 0 && box.x + box.width <= width, 'reason fits viewport')
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(await reason.isVisible(), false)
    await page.getByRole('button', { name: 'Health check details: Failed', exact: true }).focus()
    await page.keyboard.press('Enter')
    assert.ok(await reason.isVisible(), 'keyboard activation opens health details')
    await page.keyboard.press('Escape')
    assert.equal(await reason.isVisible(), false)
    await page.locator('.model-card-content strong').filter({ hasText: 'Persisted custom ASR' }).waitFor()
    await page.reload()
    await page.locator('.model-card-content strong').filter({ hasText: 'Persisted custom ASR' }).waitFor()
    await page.setViewportSize({width:1440,height:900})
    const tabs=await page.locator('.model-filter button').allTextContents()
    assert.equal(tabs.length,6)
    assert.ok(tabs.some(t=>t.startsWith('Others')))
    assert.ok(!tabs.some(t=>t.startsWith('Embedding')))
    const card=page.locator('.model-list-item').filter({hasText:'Persisted custom ASR'})
    assert.equal(apiTests.length,0,'tests must be explicit')
    assert.equal(await card.getByRole('button',{name:'Test API',exact:true}).count(),0,'cards expose no test button')
    await card.locator('.model-card-content').click()
    const editor=page.locator('.model-dialog')
    const settingsTab=editor.getByRole('tab',{name:'Settings',exact:true})
    const testTab=editor.getByRole('tab',{name:'API test',exact:true})
    assert.equal(await settingsTab.getAttribute('aria-selected'),'true')
    assert.equal(await editor.getByRole('button',{name:'Test API',exact:true}).isVisible(),false)
    await testTab.click()
    assert.equal(apiTests.length,0,'opening test tab does not send requests')
    await editor.getByRole('button',{name:'Test API',exact:true}).click()
    await editor.getByRole('status').filter({hasText:'Fixture API model list check'}).waitFor()
    assert.deepEqual(apiTests[0],{id:'custom-asr'})
    await settingsTab.click()
    await testTab.click()
    await editor.getByRole('status').filter({hasText:'Fixture API model list check'}).waitFor()
    assert.equal(apiTests.length,1,'switching tabs preserves result without retesting')
    await settingsTab.click()
    await editor.getByPlaceholder('Endpoint URL',{exact:true}).fill('https://draft.invalid/v1')
    await editor.getByPlaceholder('Model name / model ID',{exact:true}).fill('draft-model')
    await testTab.click()
    await editor.getByRole('button',{name:'Test API',exact:true}).click()
    await editor.getByRole('status').filter({hasText:'Fixture API model list check'}).waitFor()
    assert.equal(apiTests.length,2)
    assert.equal(apiTests[1].endpoint,'https://draft.invalid/v1')
    assert.equal(apiTests[1].model,'draft-model')
    await settingsTab.click()
    await editor.getByPlaceholder('Model name / model ID',{exact:true}).fill('changed-again')
    assert.equal(await editor.getByRole('status').count(),0,'editing test input invalidates its result')
    assert.equal(apiTests.length,2,'editing does not auto-test or save')
    await editor.getByRole('button',{name:'Close',exact:true}).click()
    // Every local card opens a read-only editor and still exposes its explicit test.
    const localCard = page.locator('.model-list-item').filter({hasText:'Local speaker fixture'})
    await localCard.locator('.model-card-content').click()
    assert.equal(await editor.getByPlaceholder('Endpoint URL',{exact:true}).getAttribute('readonly'),'')
    assert.equal(await editor.getByRole('button',{name:'Delete model',exact:true}).count(),0)
    await editor.getByRole('tab',{name:'API test',exact:true}).click()
    await editor.getByRole('button',{name:'Test API',exact:true}).click()
    await editor.getByRole('status').waitFor()
    assert.deepEqual(apiTests.at(-1),{id:'local-sherpa-diarization'})
    await page.keyboard.press('Escape')
    assert.equal(await editor.count(),0)
    // Explicit errors can retry; closing a pending test aborts and cannot leak a result.
    await card.locator('.model-card-content').click()
    await editor.getByRole('tab',{name:'API test',exact:true}).click()
    testMode = 'error'
    await editor.getByRole('button',{name:'Test API',exact:true}).click()
    await editor.getByRole('alert').filter({hasText:'Fixture test unavailable'}).waitFor()
    testMode = 'healthy'
    await editor.getByRole('button',{name:'Test API',exact:true}).click()
    await editor.getByRole('status').waitFor()
    testMode = 'pending'
    const countBeforePending = apiTests.length
    await editor.getByRole('button',{name:'Test API',exact:true}).click()
    await editor.getByRole('button',{name:'Testing…',exact:true}).waitFor()
    assert.equal(await editor.getByRole('button',{name:'Testing…',exact:true}).isDisabled(),true)
    await page.waitForFunction(() => document.querySelector('.model-api-test-button')?.disabled)
    await page.keyboard.press('Escape')
    assert.equal(await editor.count(),0)
    assert.equal(apiTests.length,countBeforePending+1)
    await testPending.shift().fulfill({status:200,contentType:'application/json',body:JSON.stringify({result:{id:'custom-asr',state:'healthy',elapsedMs:1,reason:'Late stale result',checkedAt:Date.now()}})}).catch(()=>{})
    testMode = 'healthy'
    await card.locator('.model-card-content').click()
    await editor.getByRole('tab',{name:'API test',exact:true}).click()
    assert.equal(await editor.getByRole('status').count(),0)
    await page.keyboard.press('Escape')
    const serviceCard=page.locator('.model-list-item.model-summary')
    await serviceCard.locator('.model-card-content').click()
    assert.equal(await editor.getByPlaceholder('Endpoint URL',{exact:true}).getAttribute('readonly'),'')
    assert.equal(await editor.getByRole('button',{name:'Save changes',exact:true}).count(),0,'environment settings cannot pretend to save ignored edits')
    await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'Register model',exact:true}).click()
    assert.equal(await page.locator('.model-dialog').getByRole('tab',{name:'API test',exact:true}).count(),0,'registration has no API test tab')
    assert.equal(await page.locator('.model-dialog').getByRole('button',{name:'Test API',exact:true}).count(),0,'registration has no API test button')
    await editor.locator('select').first().selectOption('summary')
    assert.equal(await editor.getByRole('button',{name:'Register model',exact:true}).isDisabled(),true,'a configured environment service cannot be silently replaced')
    await editor.locator('select').first().selectOption('asr')
    assert.equal(await editor.getByRole('button',{name:'Register model',exact:true}).isDisabled(),false)
    await page.locator('.model-dialog').getByRole('button',{name:'Close',exact:true}).click()
    await page.getByRole('button',{name:/^Others/}).click()
    assert.equal(await page.locator('.model-list-item.model-asr').count(),0)
    await page.getByRole('button',{name:/^All/}).click()
    await card.waitFor()
    assert.deepEqual(errors, [])
    console.log('PASS Web model health, tabbed saved/draft API tests, no accidental editing, stale-result invalidation and six model categories')
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
