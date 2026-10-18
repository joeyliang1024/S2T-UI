const assert = require('node:assert/strict')
const { createServer } = require('node:http'), { buildSync } = require('esbuild')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
;(async () => {
  const code = buildSync({ entryPoints: ['src/renderer/src/features/sessions/services/session-outbox.ts'], bundle: true, format: 'iife', globalName: 'Outbox', platform: 'browser', write: false }).outputFiles[0].text
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Outbox test</title>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch(browserOptions()), context = await browser.newContext()
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    await page.goto(origin); await page.addScriptTag({ content: code })
    await page.evaluate(async () => {
      const record = title => ({ id: 'a', title, createdAt: '2026-10-14', segments: [], transcript: title, durationMs: 0, source: 'fixture', audioKey: 'a' })
      const store = Outbox.createSessionOutbox('user-a')
      const snapshot = { baseline: [record('base')], local: [record('local')] }
      const write = store.save(snapshot); snapshot.local[0].title = 'mutated after acceptance'; await write
      window.fixture = { snapshot, record }
      if ((await store.read()).local[0].title !== 'local') throw Error('checkpoint was mutated after acceptance')
      await store.close()
    })
    await page.reload(); await page.addScriptTag({ content: code })
    const restored = await page.evaluate(async () => {
      const store = Outbox.createSessionOutbox('user-a'), restored = await store.read()
      const next = { ...restored, local: [{ ...restored.local[0], title: 'newer' }] }
      await store.save(next)
      const oldAck = await store.acknowledge(restored.local)
      const retained = await store.read()
      const foreign = Outbox.createSessionOutbox('user-b'); const other = await foreign.read(); await foreign.close()
      await store.close()
      return { restored: restored.local[0].title, oldAck, retained: retained.local[0].title, foreignEmpty: other === undefined }
    })
    assert.deepEqual(restored, { restored: 'local', oldAck: false, retained: 'newer', foreignEmpty: true })
    const otherPage = await context.newPage(); await otherPage.goto(origin); await otherPage.addScriptTag({ content: code })
    assert.equal(await otherPage.evaluate(async () => { const store = Outbox.createSessionOutbox('user-a'); const row = await store.read(); await store.close(); return row === undefined }), true, 'another tab must not consume this tab checkpoint')
    const deleted = await page.evaluate(async () => {
      const store = Outbox.createSessionOutbox('user-a'), row = await store.read()
      const ack = await store.acknowledge(row.local), empty = await store.read(); await store.close()
      return ack && empty === undefined
    })
    assert.equal(deleted, true)
    // Accepted writes drain before close; closing cannot silently lose the last edit.
    assert.equal(await page.evaluate(async () => {
      const store = Outbox.createSessionOutbox('user-a')
      const snapshot = { baseline: [], local: [{ id: 'drained', title: 'last edit' }] }
      const accepted = store.save(snapshot), closing = store.close()
      await Promise.all([accepted, closing])
      let rejected = false
      try { await store.save(snapshot) } catch (error) { rejected = error.name === 'AbortError' }
      const reopened = Outbox.createSessionOutbox('user-a'), restored = await reopened.read()
      await reopened.close()
      return rejected && restored.local[0].title === 'last edit'
    }), true)
    // Corrupt persisted data must remain available for recovery, never be acknowledged away.
    assert.equal(await page.evaluate(async () => {
      const key = `user-a:${sessionStorage.getItem('s2t-session-outbox-owner')}`
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('s2t-session-outbox', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      const corrupt = { key, userId: 'user-a', version: 1, baseline: [], local: [{ title: 'missing ID' }] }
      await new Promise((resolve, reject) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(corrupt); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      const store = Outbox.createSessionOutbox('user-a'); let rejected = 0
      for (const action of [() => store.read(), () => store.acknowledge(corrupt.local)]) { try { await action() } catch { rejected++ } }
      await store.close()
      const retained = await new Promise((resolve, reject) => { const tx = db.transaction('pending'); const r = tx.objectStore('pending').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      db.close(); return rejected === 2 && retained.local[0].title === 'missing ID'
    }), true)
    assert.deepEqual(errors, [])
    console.log('PASS real IndexedDB: durable reload, immutable accepted checkpoint, stale ACK retention, account/tab isolation, matching ACK cleanup, close drain and corrupt-data retention')
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
