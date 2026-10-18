const assert = require('node:assert/strict'), { buildSync } = require('esbuild'), { createServer } = require('node:http')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
;(async () => {
  const code = buildSync({ stdin: { contents: "export * from './src/renderer/src/features/capture/recording/adapters/opfs-pcm-recording'; export * from './src/renderer/src/features/capture/recording/adapters/pcm-sinks';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'Pcm', platform: 'browser', write: false }).outputFiles[0].text
  const server = createServer((_request, response) => response.end('<title>OPFS recovery</title>')); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const browser = await chromium.launch(browserOptions())
  try {
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`); await page.addScriptTag({content:code})
    await page.evaluate(async () => {
      const first = await Pcm.OpfsPcmRecording.create('unfinished-first',16000)
      const firstSink = Pcm.createBrowserPcmSink({ recordingId: 'unfinished-first', recording: first, remoteRecording: null, onWriteStage: () => {} })
      await firstSink.append(new Uint8Array([1,2,3,4]).buffer); await firstSink.append(new Uint8Array([5,6]).buffer)
      const second = await Pcm.OpfsPcmRecording.create('unfinished-second',48000); await second.append(new Uint8Array([7,8]).buffer)
      const failed = await Pcm.OpfsPcmRecording.create('remote-failed',16000)
      const failedSink = Pcm.createBrowserPcmSink({ recordingId: 'remote-failed', recording: failed, remoteRecording: { append: async () => { throw Error('mock remote outage') }, finish: async () => {} }, onWriteStage: () => {} })
      let rejected = false; try { await failedSink.append(new Uint8Array([9,10]).buffer) } catch { rejected = true }
      if (!rejected) throw Error('remote outage did not reject append')
      await failedSink.abort()
      // No finish, no controller shutdown hook: discard all JS state by reloading.
    })
    await page.reload(); await page.addScriptTag({content:code})
    const result = await page.evaluate(async () => {
      const read = async (id,rate) => { const blob = await Pcm.OpfsPcmRecording.recover(id,rate); return blob ? [...new Uint8Array(await blob.arrayBuffer()).slice(44)] : null }
      const first = await read('unfinished-first',16000), second = await read('unfinished-second',48000), retry = await read('unfinished-first',16000)
      await Pcm.OpfsPcmRecording.acknowledgeRecovery('unfinished-first')
      return { first, second, retry, removed: await read('unfinished-first',16000), otherRetained: await read('unfinished-second',48000), failedRetained: await read('remote-failed',16000) }
    })
    assert.deepEqual(result, { first:[1,2,3,4,5,6],second:[7,8],retry:[1,2,3,4,5,6],removed:null,otherRetained:[7,8],failedRetained:[9,10] })
    console.log('PASS real Chrome OPFS: production sink appends survive reload without finish, remote failure/abort retains local audio, repeatable reads and isolated ACK cleanup')
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
