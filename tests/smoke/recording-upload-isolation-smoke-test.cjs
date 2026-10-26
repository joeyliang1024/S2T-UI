const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const code = buildSync({ stdin: { contents: "export * from './frontend/src/features/capture/recording/durable-upload'; export * from './frontend/src/features/capture/recording/adapters/remote-pcm-recording'; export * from './frontend/src/features/capture/recording/buffered-writer'; export * from './frontend/src/shared/http/authenticated-client';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module', 'exports', 'require', code)(m, m.exports, require)
const { DurableRecordingUpload, RemotePcmRecording, BufferedPcmWriter, pcmRecordingBufferLimits, setAuthenticatedUser } = m.exports
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }
const until = async fn => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(fn(), 'background operation did not settle') }
global.window = { setTimeout, clearTimeout }
;(async () => {
  setAuthenticatedUser('owner-a')
  const chunks = [], reads = [], pressure = [], remoteBytes = []
  let localBytes = 0, release, remoteSamples = 0, finished = false
  const gate = new Promise(resolve => { release = resolve })
  const source = {
    get persistedSamples() { return localBytes / 2 },
    async readCommittedAudio(start, maximum) {
      reads.push(maximum)
      const bytes = Buffer.concat(chunks).subarray(start * 2, Math.min(localBytes, (start + maximum) * 2))
      return Uint8Array.from(bytes).buffer
    }
  }
  const destination = { get persistedSamples() { return remoteSamples }, async append(bytes) { await gate; remoteBytes.push(Buffer.from(bytes)); remoteSamples += bytes.byteLength / 2 }, async finish() { finished = true } }
  const upload = new DurableRecordingUpload(source, destination)
  const limits = pcmRecordingBufferLimits(48000)
  const writer = new BufferedPcmWriter(async bytes => { chunks.push(Buffer.from(bytes)); localBytes += bytes.byteLength; upload.notify() }, active => pressure.push(active), error => { throw error }, limits.batchBytes, limits.maximumPendingBytes)
  // Two minutes of capture while the remote request remains blocked. Only
  // local persistence controls capture backpressure; remote RAM stays bounded.
  for (let second = 0; second < 120; second++) { writer.push(new Uint8Array(96000).fill(second).buffer); await flush() }
  await writer.closeAndDrain()
  assert.equal(localBytes, 120 * 96000)
  assert.equal(remoteSamples, 0)
  assert.deepEqual(pressure, [], 'remote delay must never pause capture')
  assert.equal(reads.length, 1, 'only one in-flight upload buffer may be materialized')
  release(); await upload.finish()
  assert.ok(finished)
  assert.deepEqual(Buffer.concat(remoteBytes), Buffer.concat(chunks))
  assert.ok(reads.every(samples => samples <= 512 * 1024))
  await upload.abort()

  // A server can commit an upload before its response is lost. Retry the same
  // chunk index/bytes, advance only on durable ACK, and never duplicate audio.
  const bytes = new Uint8Array(1024 * 1024 + 20).map((_, i) => i % 251), stored = new Map(), starts = []
  let lost = false, calls = 0, available = 192000
  const remote = new RemotePcmRecording('lost-ack', 48000, async (path, init) => {
    if (path.endsWith('/finish')) return new Response('{}')
    calls++
    const index = Number(path.split('/').at(-1)), body = Buffer.from(init.body)
    starts.push(Number(init.headers['x-s2t-start-sample']))
    if (stored.has(index)) assert.deepEqual(stored.get(index), body)
    else stored.set(index, body)
    if (!lost) { lost = true; available = bytes.length; throw new TypeError('response lost after commit while new audio keeps arriving') }
    const size = [...stored.values()].reduce((n, b) => n + b.length, 0)
    return Response.json({ durable: true, contiguousChunks: index + 1, persistedSamples: size / 2 })
  })
  const statuses = []
  const retrying = new DurableRecordingUpload({ get persistedSamples() { return available / 2 }, readCommittedAudio: async (start, max) => bytes.slice(start * 2, Math.min(available, (start + max) * 2)).buffer }, remote, state => statuses.push(state))
  retrying.notify()
  await until(() => remote.persistedSamples === bytes.length / 2)
  await retrying.finish()
  assert.ok(remote.isFinished)
  assert.deepEqual(Buffer.concat([...stored.values()]), Buffer.from(bytes))
  assert.deepEqual(starts, [0, 0, 96000]); assert.equal(calls, 3)
  assert.deepEqual(statuses, [true, false])
  await retrying.abort()

  // Changing accounts during an outage terminates retry, without uploading
  // retained recording bytes with the next account's credentials.
  let accountCalls = 0
  const isolated = new DurableRecordingUpload({ persistedSamples: 1, readCommittedAudio: async () => new Uint8Array([1,2]).buffer }, { persistedSamples: 0, append: async () => { accountCalls++; throw Error('offline') }, finish: async () => {} })
  isolated.notify(); await flush(); setAuthenticatedUser('owner-b')
  await assert.rejects(isolated.finish(), /Account changed/)
  await isolated.abort(); assert.equal(accountCalls, 1)
  // Permanent authorization errors are reported once, rather than retried
  // forever. The local spool remains the recovery source.
  let deniedCalls = 0, terminal
  const denied = new DurableRecordingUpload({ persistedSamples: 1, readCommittedAudio: async () => new Uint8Array([1,2]).buffer }, { persistedSamples: 0, append: async () => { deniedCalls++; throw Object.assign(Error('forbidden'), { status: 403 }) }, finish: async () => {} }, (_waiting, error) => { terminal = error })
  denied.notify(); await flush()
  await assert.rejects(denied.finish(), /forbidden/)
  assert.equal(deniedCalls, 1); assert.equal(terminal.status, 403); await denied.abort()

  // Stopping must not wait indefinitely for a blackholed upload. Production
  // uses 30 seconds; a short injected deadline exercises the same cancellation.
  let canceled = false
  const timed = new DurableRecordingUpload({ persistedSamples: 1, readCommittedAudio: async () => new Uint8Array([1,2]).buffer }, {
    persistedSamples: 0,
    append: async (_bytes, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { canceled = true; reject(new DOMException('Upload canceled', 'AbortError')) }, { once: true })),
    finish: async () => { throw Error('unfinished audio must not be marked complete') }
  }, () => {}, 20)
  timed.notify(); await flush()
  await assert.rejects(timed.finish(), error => error.name === 'TimeoutError')
  assert.ok(canceled); await timed.abort()
  // Production batching keeps tiny local commits on disk, not in remote RAM.
  // Size threshold, maximum delay and finish all independently trigger delivery.
  let availableBytes = 2, acknowledgedBytes = 0
  const batchReads = [], batchPayload = Uint8Array.from([1,2,3,4,5,6,7,8,9,10])
  const batched = new DurableRecordingUpload({ get persistedSamples() { return availableBytes / 2 }, readCommittedAudio: async (start, maximum) => { batchReads.push(start); return batchPayload.slice(start * 2, Math.min(availableBytes, (start + maximum) * 2)).buffer } }, {
    get persistedSamples() { return acknowledgedBytes / 2 }, append: async bytes => { acknowledgedBytes += bytes.byteLength }, finish: async () => {}
  }, () => {}, 1000, { minimumBytes: 8, maximumDelayMs: 1000 })
  batched.notify(); await flush(); assert.equal(batchReads.length, 0)
  availableBytes = 8; batched.notify(); await until(() => acknowledgedBytes === 8)
  availableBytes = 10; batched.notify(); await flush(); assert.equal(batchReads.length, 1)
  await batched.finish(); assert.equal(acknowledgedBytes, 10); assert.deepEqual(batchReads, [0,4]); await batched.abort()
  let delayedBytes = 0
  const delayed = new DurableRecordingUpload({ persistedSamples: 1, readCommittedAudio: async () => new Uint8Array([1,2]).buffer }, {
    get persistedSamples() { return delayedBytes / 2 }, append: async bytes => { delayedBytes += bytes.byteLength }, finish: async () => {}
  }, () => {}, 1000, { minimumBytes: 1024, maximumDelayMs: 20 })
  delayed.notify(); await until(() => delayedBytes === 2); await delayed.finish(); await delayed.abort()
  console.log('PASS recording upload isolation: 120s blocked network without capture pressure, bounded reads, exact catch-up, lost ACK retry without duplicates, account fencing, permanent-error handling and bounded finalization, size/deadline batching and forced final tail')
})().catch(error => { console.error(error); process.exitCode = 1 })
