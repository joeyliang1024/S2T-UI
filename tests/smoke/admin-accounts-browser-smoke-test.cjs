// Production React account-management UI with an isolated loopback admin API.
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, browserOptions } = require('../helpers/browser.cjs')

;(async () => {
  const root = path.resolve('out/web')
  const accounts = [
    { id: 'admin-current', username: 'admin', NT: 'admin', Department: 'Platform', role: 'admin', createdAt: '2026-10-15' },
    { id: 'user-target', username: 'target', NT: 'target', Department: 'Product', role: 'user', createdAt: '2026-10-15', sharingAuthorization: { approved: false, department: 'Product' } },
    { id: 'admin-other', username: 'otheradmin', NT: 'otheradmin', Department: 'Security', role: 'developer', createdAt: '2026-10-15', sharingAuthorization: { approved: true, department: 'Security' } }
  ]
  let deletes = 0, currentRole = 'admin', accountReads = 0, historySessions = []
  let releaseContinuationAudio
  const continuationAudioGate = new Promise(resolve => { releaseContinuationAudio = resolve })
  const wave = Buffer.alloc(44 + 32000)
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(32000, 40)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (!url.pathname.startsWith('/api/')) {
      let file = path.join(root, url.pathname)
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end() }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
      res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
      return res.end(fs.readFileSync(file))
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    if (url.pathname === '/api/auth/session') return send({ user: { ...accounts[0], role: currentRole } })
    if (url.pathname === '/api/config') return send({ asr: { configured: false }, translation: { configured: false }, summary: { configured: false }, diarization: { configured: false }, asrProfiles: [] })
    if (url.pathname === '/api/data/settings') return send(req.method === 'POST' ? { version: 1 } : { settings: { uiLanguage: 'en', theme: 'system' }, version: 0 })
    if (url.pathname === '/api/data/sessions') return send(req.method === 'POST' ? { version: 1 } : { sessions: historySessions, version: 0 })
    if (url.pathname === '/api/data/live-draft' || url.pathname === '/api/data/import-checkpoint') return send({})
    if (url.pathname === '/api/data/summary-templates') return send(req.method === 'POST' ? { version: 1 } : { templates: [], selectedTemplateId: undefined, version: 0 })
    if (url.pathname === '/api/data/model-registry') return send({ models: [{ id: 'readonly-asr', name: 'Shared ASR', purpose: 'asr', model: 'shared', endpoint: 'http://127.0.0.1:9/v1', requiresApiKey: false }], version: 0 })
    if (url.pathname === '/api/data/voiceprints') return send({ voiceprints: [] })
    if (url.pathname === '/api/data/storage-status') return send({ audioPending: 0, voiceprintPending: 0 })
    if (url.pathname === '/api/storage') return send({ mode: { blob: 'local', config: 'local', vector: 'local' }, schemaVersion: 'fixture', ready: true })
    if (url.pathname === '/api/admin/users') { accountReads++; return send({ users: accounts }) }
    const roleMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/)
    if (roleMatch && req.method === 'PUT') {
      const account = accounts.find(item => item.id === decodeURIComponent(roleMatch[1]))
      if (!account || account.role === 'admin' || !['developer', 'user'].includes(body.role)) return send({ error: 'invalid role change' }, 400)
      account.role = body.role
      return send({ user: account })
    }
    const accountMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (accountMatch && req.method === 'DELETE') {
      deletes++
      if (deletes === 1) return send({ error: 'fixture cleanup unavailable' }, 503)
      const id = decodeURIComponent(accountMatch[1]), index = accounts.findIndex(account => account.id === id)
      if (index < 0) return send({ error: 'not found' }, 404)
      accounts.splice(index, 1)
      return send({ deleted: true })
    }
    const sharingMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/sharing-authorization$/)
    if (sharingMatch && req.method === 'PUT') {
      const account = accounts.find(item => item.id === decodeURIComponent(sharingMatch[1]))
      if (!account) return send({ error: 'not found' }, 404)
      account.sharingAuthorization = { approved: Boolean(body.approved), department: String(body.department || '') }
      return send({ account })
    }
    if (url.pathname === '/api/data/audio/continuation-audio' && req.method === 'GET') {
      await continuationAudioGate
      res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wave)
    }
    if (url.pathname.startsWith('/api/data/audio/')) return send({}, req.method === 'GET' ? 404 : 200)
    return send({})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch(browserOptions())
  const errors = []
  const openAccounts = async (page) => {
    await page.goto(origin + '/history')
    await page.getByRole('button', { name: 'Preferences' }).click()
    await page.getByRole('button', { name: 'Accounts' }).click()
    await page.getByRole('heading', { name: 'Account management' }).waitFor()
  }
  // The sharing column stacks two controls: trusted department (label and field
  // sharing one line) above, approval toggle below. Assert that arrangement —
  // not merely that the row fits — so a regression back to the cramped
  // side-by-side layout is caught.
  const assertSharingControlsFit = async (page) => {
    const editors = page.locator('.admin-sharing-editor')
    await editors.first().waitFor()
    assert.equal(await editors.count(), accounts.length)
    for (let index = 0; index < await editors.count(); index++) {
      const editor = editors.nth(index)
      assert.equal(await editor.locator('input[type="checkbox"]').count(), 1, `row ${index} must expose exactly one sharing toggle`)
      const box = await editor.boundingBox(), cell = await editor.locator('..').boundingBox()
      assert.ok(box && cell && box.x + box.width <= cell.x + cell.width + 1, `sharing editor overflows its cell in row ${index}`)

      const departmentLabel = editor.locator('label:not(.admin-sharing-toggle)')
      const department = departmentLabel.locator('input')
      const toggle = editor.locator('.admin-sharing-toggle input[type="checkbox"]')
      const labelBox = await departmentLabel.boundingBox(), departmentBox = await department.boundingBox(), toggleBox = await toggle.boundingBox()
      assert.ok(labelBox && departmentBox && toggleBox, `row ${index} sharing controls must be laid out`)
      assert.ok(Math.abs(labelBox.y - departmentBox.y) < 2, `row ${index} trusted department label and field must share one line`)
      assert.ok(departmentBox.x > labelBox.x, `row ${index} trusted department field must sit beside its label`)
      assert.ok(toggleBox.y >= departmentBox.y + departmentBox.height - 1, `row ${index} approval toggle must sit below the trusted department`)
    }
  }
  try {
    const desktop = await browser.newPage({ viewport: { width: 1820, height: 1100 }, colorScheme: 'light' })
    desktop.on('pageerror', error => errors.push(error.message))
    await openAccounts(desktop)
    assert.equal(await desktop.locator('html').getAttribute('data-theme'), 'light')
    await assertSharingControlsFit(desktop)
    await desktop.getByLabel('Role: target', { exact: true }).selectOption('developer')
    await desktop.getByText('Account role updated', { exact: true }).waitFor()
    assert.equal(accounts.find(account => account.id === 'user-target').role, 'developer')
    await desktop.getByLabel('Role: target', { exact: true }).selectOption('user')
    await desktop.waitForFunction(() => document.querySelector('select[aria-label="Role: target"]').value === 'user')
    // The toggle must survive the save round-trip: flip it and confirm the
    // refreshed record — not just the optimistic click — agrees.
    const toggle = desktop.locator('.admin-sharing-editor input[type="checkbox"]').nth(1)
    const before = await toggle.isChecked()
    await toggle.click()
    await desktop.waitForFunction((checked) => document.querySelectorAll('.admin-sharing-editor input[type="checkbox"]')[1].checked === checked, !before)
    assert.notEqual(await toggle.isChecked(), before, 'sharing toggle must show the saved approval state')
    const filters = desktop.locator('.admin-account-filters')
    await filters.getByRole('searchbox').fill('  ＴＡＲＧＥＴ  ')
    assert.equal(await desktop.locator('.admin-account-table tbody tr').count(), 1)
    await filters.getByRole('searchbox').fill('')
    await filters.getByLabel('Department', { exact: true }).selectOption('Security')
    assert.equal(await desktop.locator('.admin-account-table tbody tr').count(), 1)
    await filters.getByLabel('Role', { exact: true }).selectOption('user')
    await desktop.getByText('No matching accounts', { exact: true }).waitFor()
    await filters.getByLabel('Department', { exact: true }).selectOption('')
    await filters.getByLabel('Role', { exact: true }).selectOption('')
    await desktop.screenshot({ path: '/tmp/s2t-admin-settings-desktop.png', fullPage: true })

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })
    const mobile = await mobileContext.newPage()
    mobile.on('pageerror', error => errors.push(error.message))
    await openAccounts(mobile)
    assert.equal(await mobile.locator('html').getAttribute('data-theme'), 'dark')
    await assertSharingControlsFit(mobile)
    const mobileDelete = mobile.getByRole('button', { name: 'Delete account: target' })
    await mobileDelete.scrollIntoViewIfNeeded()
    await mobileDelete.click()
    const mobileDialog = mobile.locator('dialog[open]')
    await mobileDialog.waitFor()
    assert.equal(await mobileDialog.getByLabel('Type the account name to confirm').isVisible(), true)
    assert.equal(await mobileDialog.getByRole('button', { name: 'Cancel' }).isVisible(), true)
    const layout = await mobile.evaluate(() => {
      const scroll = document.querySelector('.admin-account-table-scroll')
      return { bodyOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth, tableScrolls: Boolean(scroll && scroll.scrollWidth > scroll.clientWidth) }
    })
    assert.deepEqual(layout, { bodyOverflows: false, tableScrolls: true }, 'only the account-table container scrolls on mobile')
    await mobileDialog.getByRole('button', { name: 'Cancel' }).click()
    await mobileDialog.waitFor({ state: 'detached' })
    assert.equal(deletes, 0, 'the mobile dialog cancel sends no delete request')
    await mobile.screenshot({ path: '/tmp/s2t-admin-settings-mobile.png', fullPage: true })
    await mobileContext.close()

    assert.equal(await desktop.getByRole('button', { name: 'Delete account: admin' }).count(), 0, 'the signed-in admin cannot be deleted')
    const targetDelete = desktop.getByRole('button', { name: 'Delete account: target' })
    await targetDelete.click()
    const dialog = desktop.locator('dialog[open]')
    await dialog.waitFor()
    const confirmation = dialog.getByLabel('Type the account name to confirm')
    const submit = dialog.getByRole('button', { name: 'Delete account' })
    assert.equal(await submit.isDisabled(), true)
    await confirmation.fill('wrongname')
    assert.equal(await submit.isDisabled(), true, 'a mismatched account name cannot submit deletion')
    await confirmation.press('Enter')
    assert.equal(deletes, 0, 'a mismatched account name sends no delete request')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(deletes, 0, 'cancelling deletion sends no delete request')
    await targetDelete.click()
    await dialog.waitFor()
    await dialog.getByLabel('Type the account name to confirm').fill('target')
    assert.equal(await submit.isDisabled(), false)
    await submit.click()
    await dialog.getByRole('alert').waitFor()
    assert.match(await dialog.getByRole('alert').innerText(), /fixture cleanup unavailable/)
    assert.equal(await dialog.count(), 1, 'a failed delete keeps the dialog open for retry')
    const accountCell = (username) => desktop.locator('.admin-account-table tbody tr > td:first-child').getByText(username, { exact: true })
    assert.equal(await accountCell('target').count(), 1, 'a failed delete retains the account row')
    await submit.click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await accountCell('target').count(), 0)
    assert.equal(await accountCell('admin').count(), 1)
    assert.equal(await accountCell('otheradmin').count(), 1)
    assert.equal(deletes, 2)

    // Exercise production role gates, including direct navigation and advanced parameters.
    currentRole = 'developer'
    const developerPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    developerPage.on('pageerror', error => errors.push(error.message))
    const beforeReads = accountReads
    await developerPage.goto(origin + '/models')
    await developerPage.locator('.sidebar-nav [data-view="models"]').waitFor()
    await developerPage.locator('.model-list-item').first().waitFor()
    assert.equal(await developerPage.locator('.model-filter-row > button').count(), 0, 'developer cannot register models')
    assert.equal(await developerPage.locator('.model-active-panel select:not(:disabled)').count(), 0, 'developer cannot switch shared models')
    assert.equal(await developerPage.locator('.model-list-item[role="button"]').count(), 0, 'developer model cards are read-only')
    await developerPage.locator('.model-list-item').first().click()
    assert.equal(await developerPage.locator('.model-dialog').count(), 0, 'developer cannot open model editing')
    for (const id of ['models', 'voiceprints', 'quality-comparison']) assert.equal(await developerPage.locator(`.sidebar-nav [data-view="${id}"]`).count(), 1)
    await developerPage.getByRole('button', { name: 'Preferences', exact: true }).click()
    assert.equal(await developerPage.locator('.settings-category-nav').getByRole('button', { name: 'Accounts', exact: true }).count(), 0, 'developer never sees account management')
    await developerPage.getByRole('button', { name: 'Advanced VAD and translation parameters', exact: true }).click()
    await developerPage.getByRole('heading', { name: 'Advanced VAD and translation parameters', exact: true }).waitFor()
    await developerPage.locator('.settings-card input[type="checkbox"]').check()
    assert.ok(await developerPage.locator('.admin-settings-grid input[type="number"]').count() > 5, 'developer can use detailed VAD and translation parameters')
    assert.equal(accountReads, beforeReads, 'developer does not request the account list')
    currentRole = 'user'
    const userPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    userPage.on('pageerror', error => errors.push(error.message))
    await userPage.addInitScript(() => { if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error('isolated fixture: no physical microphone') } })
    await userPage.goto(origin + '/settings')
    await userPage.locator('.settings-category-nav').waitFor()
    for (const id of ['models', 'voiceprints', 'quality-comparison']) assert.equal(await userPage.locator(`.sidebar-nav [data-view="${id}"]`).count(), 0)
    assert.equal(await userPage.locator('.settings-category-nav').getByRole('button', { name: 'Accounts', exact: true }).count(), 0)
    assert.equal(await userPage.getByRole('button', { name: 'Advanced VAD and translation parameters', exact: true }).count(), 0)
    assert.equal(await userPage.locator('.settings-card input[type="checkbox"]').count(), 1, 'user transcription settings keep only microphone denoise')
    await userPage.locator('.sidebar-nav [data-view="live"]').click()
    await userPage.getByRole('button', { name: 'Start recording', exact: true }).waitFor()
    assert.equal(await userPage.locator('.audio-source-picker-trigger').count(), 0, 'there is no extra audio-source button')
    await userPage.locator('.live-controls-trigger').click()
    await userPage.locator('#live-sidebar-capture').waitFor()
    assert.equal(await userPage.locator('#live-sidebar-capture').getByRole('combobox', { name: 'Microphone', exact: true }).count(), 1, 'the original microphone dropdown is preserved')
    assert.equal(await userPage.locator('#live-sidebar-capture').getByRole('combobox', { name: 'System audio', exact: true }).count(), 1, 'the original computer-audio dropdown is preserved')
    assert.equal(await userPage.getByRole('dialog').count(), 0, 'original capture controls still open the sidebar')
    await userPage.getByRole('button', { name: 'Start recording', exact: true }).click()
    await userPage.getByRole('heading', { name: 'Audio sources and sound check', exact: true }).waitFor()
    assert.equal(await userPage.locator('.live-workspace').getAttribute('data-capture-state'), 'idle', 'opening the chooser does not start recording')
    assert.equal(await userPage.getByRole('dialog').getByRole('combobox', { name: 'System audio', exact: true }).count(), 1)
    assert.equal(await userPage.getByRole('dialog').getByRole('button', { name: 'Confirm and start recording', exact: true }).count(), 1)
    await userPage.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await userPage.locator('#live-sidebar-capture').isVisible(), true, 'canceling the start chooser preserves the original settings')
    assert.equal(await userPage.locator('.live-workspace').getAttribute('data-capture-state'), 'idle', 'cancel never starts recording')
    historySessions = [{ id: 'history-continue', title: 'History continuation', createdAt: '2026-10-20T00:00:00Z', durationMs: 1000, source: 'microphone', audioKey: 'continuation-audio', transcript: 'Loaded history caption', segments: [{ id: 'history-caption', status: 'final', revision: 1, startMs: 0, endMs: 1000, sourceText: 'Loaded history caption' }] }]
    await userPage.goto(origin + '/history')
    await userPage.locator('.session-more-button').click()
    await userPage.getByRole('menuitem', { name: 'Continue recording', exact: true }).click()
    await userPage.waitForURL('**/live')
    await userPage.locator('.live-workspace').waitFor()
    await userPage.locator('.transcript').getByText('Loaded history caption', { exact: true }).waitFor()
    assert.equal(await userPage.getByRole('dialog').count(), 0, 'no chooser while history audio is still loading')
    assert.equal(await userPage.locator('.live-workspace').getAttribute('data-capture-state'), 'idle')
    releaseContinuationAudio()
    await userPage.getByRole('dialog').waitFor()
    assert.equal(new URL(userPage.url()).pathname, '/live', 'history continuation chooser appears only in Live')
    assert.equal(await userPage.getByRole('dialog').getByRole('button', { name: 'Confirm and start recording', exact: true }).count(), 1)
    await userPage.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await userPage.locator('.live-workspace').getAttribute('data-capture-state'), 'idle')
    assert.equal(await userPage.locator('.transcript').getByText('Loaded history caption', { exact: true }).count(), 1, 'cancel leaves the loaded history in Live without recording')
    await developerPage.close(); await userPage.close()

    assert.deepEqual(errors, [])
    console.log('PASS real React admin/developer/user gates, role editing and detailed parameters: responsive sharing controls, contained mobile table scroll, guarded native delete dialog, retry and account retention')
  } finally {
    releaseContinuationAudio()
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
