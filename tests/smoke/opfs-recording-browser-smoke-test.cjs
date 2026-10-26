const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { chromium, browserOptions } = require('../helpers/browser.cjs')
;(async () => {
  const { createServer } = await import('vite')
  const server = await createServer({ configFile: resolve('config/vite.web.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false } })
  let browser
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch(browserOptions({ args: ['--autoplay-policy=no-user-gesture-required'] }))
    const page = await browser.newPage()
    page.on('console', message => { if (message.text().includes('opfs_upload_blocked')) console.log(message.text()) })
    await page.route(base + '/', route => route.fulfill({ contentType: 'text/html', body: '<title>OPFS recording verification</title>' }))
    await page.goto(base)
    const result = await page.evaluate(async ({ stallMs }) => {
      const { OpfsPcmRecording } = await import('/src/features/capture/recording/adapters/opfs-pcm-recording.ts')
      const { createBrowserPcmSink } = await import('/src/features/capture/recording/adapters/pcm-sinks.ts')
      const { BufferedPcmWriter, pcmRecordingBufferLimits } = await import('/src/features/capture/recording/buffered-writer.ts')
      const first = await OpfsPcmRecording.create('unfinished-first', 16000)
      const firstSink = createBrowserPcmSink({ recordingId: 'unfinished-first', recording: first, remoteRecording: null, onWriteStage: () => {} })
      await firstSink.append(new Uint8Array([1,2,3,4]).buffer); await firstSink.append(new Uint8Array([5,6]).buffer)
      const second = await OpfsPcmRecording.create('unfinished-second', 48000); await second.append(new Uint8Array([7,8]).buffer)
      const failed = await OpfsPcmRecording.create('remote-failed', 16000)
      const failedSink = createBrowserPcmSink({ recordingId: 'remote-failed', recording: failed, remoteRecording: { persistedSamples: 0, append: async () => { throw Error('mock remote outage') }, finish: async () => {} }, onWriteStage: () => {} })
      await failedSink.append(new Uint8Array([9,10]).buffer) // Network failure must not reject local capture.
      const offline = await failedSink.finish()
      if (offline.audio.size !== 46) throw Error('offline finish did not retain local audio')
      await failedSink.abort()

      // Real AudioWorklet -> bounded PCM writer -> OPFS sync worker, while an
      // upload request remains blocked. Worklet delivery and local commits must continue.
      const recording = await OpfsPcmRecording.create('live-network-stall', 48000)
      if (!recording.writeClient) throw Error('OPFS worker did not initialize')
      let syncCommits = 0
      const write = recording.writeClient.write.bind(recording.writeClient)
      recording.writeClient.write = async (...args) => { const committed = await write(...args); if (committed) syncCommits++; return committed }
      let release, remoteSamples = 0, uploadStarted = false
      const gate = new Promise(resolve => { release = resolve }), uploaded = []
      const remote = { get persistedSamples() { return remoteSamples }, append: async bytes => { uploadStarted = true; await gate; uploaded.push(bytes); remoteSamples += bytes.byteLength / 2 }, finish: async () => {} }
      const sink = createBrowserPcmSink({ recordingId: 'live-network-stall', recording, remoteRecording: remote, onWriteStage: () => {} })
      const pressure = [], limits = pcmRecordingBufferLimits(48000)
      let failure, received = 0
      const writer = new BufferedPcmWriter(bytes => sink.append(bytes), active => pressure.push(active), error => { failure = error }, limits.batchBytes, limits.maximumPendingBytes)
      const context = new AudioContext({ sampleRate: 48000 })
      await context.audioWorklet.addModule('/src/features/capture/audio-capture.worklet.js')
      const capture = new AudioWorkletNode(context, 's2t-audio-capture'), oscillator = context.createOscillator()
      capture.port.onmessage = event => {
        const samples = new Float32Array(event.data), pcm = new Int16Array(samples.length)
        for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767)
        received += samples.length; writer.push(pcm.buffer)
      }
      oscillator.connect(capture); capture.connect(context.destination); oscillator.start(); await context.resume()
      const deadline = performance.now() + 40000
      while (!uploadStarted && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      if (!uploadStarted) throw Error('live upload did not start')
      console.log(JSON.stringify({ event: "opfs_upload_blocked", at: new Date().toISOString() }))
      const before = received
      await new Promise(resolve => setTimeout(resolve, stallMs))
      if (received - before < 48000) throw Error('audio capture stopped while network was stalled')
      if (remoteSamples !== 0 || recording.persistedSamples < 48000 * 4) throw Error('local persistence waited for network')
      await context.suspend(); oscillator.stop(); capture.disconnect(); await context.close()
      await new Promise(resolve => setTimeout(resolve, 50)); capture.port.onmessage = null
      await writer.closeAndDrain()
      if (failure) throw failure
      release()
      const artifact = await sink.finish(), audio = new Uint8Array(await artifact.audio.arrayBuffer()).slice(44)
      if (audio.length !== received * 2) throw Error('accepted worklet samples were lost before local persistence')
      const remoteAudio = new Uint8Array(await new Blob(uploaded).arrayBuffer())
      if (audio.length !== remoteAudio.length || !audio.every((value, index) => value === remoteAudio[index])) throw Error('upload catch-up changed audio')
      if (pressure.length || !syncCommits) throw Error('capture backpressure or sync worker path failed')
      const size = audio.length
      await sink.abort()
      // Emulate a process dying after a partial synchronous write, before the
      // commit marker. Recovery must ignore this tail, not claim it was durable.
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('s2t-ui-recordings')
      const directory = await root.getDirectoryHandle('unfinished-first.pcm')
      const pending = await directory.getFileHandle('0000000002.pcm', { create: true })
      const output = await pending.createWritable(); await output.write(new Uint8Array([99,99])); await output.close()
      return { syncCommits, size, received, pressure, stallMs, byteExact: true, remoteBytes: remoteAudio.length }
    }, { stallMs: Number(process.env.S2T_OPFS_STALL_MS || 2400) })
    if (process.env.S2T_OPFS_REPORT) {
      const fs = require('node:fs/promises')
      await fs.mkdir(require('node:path').dirname(process.env.S2T_OPFS_REPORT), { recursive: true })
      await fs.writeFile(process.env.S2T_OPFS_REPORT, JSON.stringify({ createdAt: new Date().toISOString(), browser: browser.version(), localOnly: true, ...result }, null, 2))
    }
    assert.ok(result.syncCommits >= 2)
    assert.ok(result.size > 48000 * 4 * 2)
    await page.reload()
    const recovered = await page.evaluate(async () => {
      const { OpfsPcmRecording } = await import('/src/features/capture/recording/adapters/opfs-pcm-recording.ts')
      const read = async (id, rate) => { const blob = await OpfsPcmRecording.recover(id, rate); return blob ? [...new Uint8Array(await blob.arrayBuffer()).slice(44)] : null }
      const first = await read('unfinished-first',16000), second = await read('unfinished-second',48000), retry = await read('unfinished-first',16000)
      await OpfsPcmRecording.acknowledgeRecovery('unfinished-first')
      return { first, second, retry, removed: await read('unfinished-first',16000), otherRetained: await read('unfinished-second',48000), failedRetained: await read('remote-failed',16000) }
    })
    assert.deepEqual(recovered, { first:[1,2,3,4,5,6],second:[7,8],retry:[1,2,3,4,5,6],removed:null,otherRetained:[7,8],failedRetained:[9,10] })
    console.log('PASS real Chrome: AudioWorklet capture continues through blocked upload, sync OPFS worker commits, exact background catch-up, offline finish, reload recovery, uncommitted tail exclusion, isolated ACK cleanup', result)
  } finally { await browser?.close(); await server.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
