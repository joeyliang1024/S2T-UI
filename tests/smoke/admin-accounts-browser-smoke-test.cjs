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
    { id: 'admin-other', username: 'otheradmin', NT: 'otheradmin', Department: 'Security', role: 'admin', createdAt: '2026-10-15', sharingAuthorization: { approved: true, department: 'Security' } }
  ]
  let deletes = 0
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
    if (url.pathname === '/api/auth/session') return send({ user: accounts[0] })
    if (url.pathname === '/api/config') return send({ asr: { configured: false }, translation: { configured: false }, summary: { configured: false }, diarization: { configured: false }, asrProfiles: [] })
    if (url.pathname === '/api/data/settings') return send(req.method === 'POST' ? { version: 1 } : { settings: { uiLanguage: 'en', theme: 'system' }, version: 0 })
    if (url.pathname === '/api/data/sessions') return send(req.method === 'POST' ? { version: 1 } : { sessions: [], version: 0 })
    if (url.pathname === '/api/data/live-draft' || url.pathname === '/api/data/import-checkpoint') return send({})
    if (url.pathname === '/api/data/summary-templates') return send(req.method === 'POST' ? { version: 1 } : { templates: [], selectedTemplateId: undefined, version: 0 })
    if (url.pathname === '/api/data/model-registry') return send({ models: [], version: 0 })
    if (url.pathname === '/api/data/voiceprints') return send({ voiceprints: [] })
    if (url.pathname === '/api/data/storage-status') return send({ audioPending: 0, voiceprintPending: 0 })
    if (url.pathname === '/api/storage') return send({ mode: { blob: 'local', config: 'local', vector: 'local' }, schemaVersion: 'fixture', ready: true })
    if (url.pathname === '/api/admin/users') return send({ users: accounts })
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
    await page.getByRole('button', { name: 'Accounts / admin parameters' }).click()
    await page.getByRole('heading', { name: 'Account management' }).waitFor()
    await page.getByRole('heading', { name: 'Admin: advanced VAD and translation parameters' }).waitFor()
  }
  const assertSharingButtonsDoNotOverlap = async (page) => {
    const rows = page.locator('.admin-sharing-editor .settings-button-row')
    await rows.first().waitFor()
    assert.equal(await rows.count(), accounts.length)
    for (let index = 0; index < await rows.count(); index++) {
      const buttons = rows.nth(index).getByRole('button')
      const first = await buttons.nth(0).boundingBox(), second = await buttons.nth(1).boundingBox()
      assert.ok(first && second && first.x + first.width <= second.x, `sharing buttons overlap in row ${index}`)
    }
  }
  try {
    const desktop = await browser.newPage({ viewport: { width: 1820, height: 1100 }, colorScheme: 'light' })
    desktop.on('pageerror', error => errors.push(error.message))
    await openAccounts(desktop)
    assert.equal(await desktop.locator('html').getAttribute('data-theme'), 'light')
    await assertSharingButtonsDoNotOverlap(desktop)
    await desktop.screenshot({ path: '/tmp/s2t-admin-settings-desktop.png', fullPage: true })

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })
    const mobile = await mobileContext.newPage()
    mobile.on('pageerror', error => errors.push(error.message))
    await openAccounts(mobile)
    assert.equal(await mobile.locator('html').getAttribute('data-theme'), 'dark')
    await assertSharingButtonsDoNotOverlap(mobile)
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

    assert.deepEqual(errors, [])
    console.log('PASS real React admin accounts: responsive sharing controls, contained mobile table scroll, guarded native delete dialog, retry and account retention')
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
