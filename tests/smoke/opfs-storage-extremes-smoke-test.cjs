const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const fs = require('node:fs'), path = require('node:path')
const source = fs.readFileSync('frontend/src/features/capture/recording/adapters/opfs-pcm-recording.ts', 'utf8').replace("import { storageDeadline } from '../../../../shared/services/storage-deadline'", fs.readFileSync('frontend/src/shared/services/storage-deadline.ts','utf8').replace('export const', 'const').replace('timeoutMs = 30_000', 'timeoutMs = 40'))
const code = buildSync({ stdin: { contents: source, resolveDir: path.resolve('frontend/src/features/capture/recording/adapters'), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',code)(m,m.exports,require)
const { OpfsPcmRecording } = m.exports
const state = { forbidFullRead: false, failClose: false, fault: '', releases: [], closes: 0 }
const notFound = () => new DOMException('Missing fixture entry', 'NotFoundError')
class Directory {
  items = new Map()
  async getDirectoryHandle(name, options = {}) { if (!this.items.has(name) && options.create) this.items.set(name, new Directory()); if (!this.items.has(name)) throw notFound(); return this.items.get(name) }
  async getFileHandle(name, options = {}) { if (!this.items.has(name) && options.create) this.items.set(name, new FileHandle(name)); if (!this.items.has(name)) throw notFound(); return this.items.get(name) }
  async removeEntry(name) { if (!this.items.delete(name)) throw notFound() }
  async *entries() { yield* this.items }
}
class FileHandle {
  bytes = new Uint8Array(); constructor(name) { this.name = name }
  async getFile() { const file = new File([this.bytes], this.name); if (state.forbidFullRead && /\.(pcm|wav)$/.test(this.name)) file.arrayBuffer = async () => { throw Error('Full source read is forbidden') }; return file }
  async createWritable() { if (state.fault === 'create') await new Promise(resolve => state.releases.push(resolve)); let staged = new Uint8Array(); const file = this; return { async write(value) { if (state.fault === 'write') await new Promise(resolve => state.releases.push(resolve)); if (state.fault === 'quota') throw new DOMException('Disk full', 'QuotaExceededError'); staged = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value) }, async close() { state.closes++; if (state.fault === 'close') await new Promise(resolve => state.releases.push(resolve)); if (state.failClose) { state.failClose = false; throw Error('disk commit failed') }; file.bytes = staged.slice() }, async abort() { if (state.fault) await new Promise(() => {}) } } }
}
const root = new Directory()
Object.defineProperty(global, 'navigator', { configurable: true, value: { language: 'en', languages: ['en'], storage: { getDirectory: async () => root } } })
const payload = async blob => [...new Uint8Array(await blob.arrayBuffer()).slice(44)]
function deadline(promise) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Error('Test operation hung')), 1000))]) }
;(async () => {
  const results = []
  for (const fault of ['create', 'write', 'close', 'quota']) {
    state.fault = ''
    const id = 'extreme-' + fault
    const recording = await OpfsPcmRecording.create(id, 16000)
    await recording.append(new Uint8Array([1, 2, 3, 4]).buffer)
    state.fault = fault
    const started = performance.now()
    await assert.rejects(deadline(recording.append(new Uint8Array([5, 6]).buffer)), error => error.name === (fault === 'quota' ? 'QuotaExceededError' : 'TimeoutError'))
    await assert.rejects(deadline(recording.append(new Uint8Array([7, 8]).buffer)))
    await assert.rejects(deadline(recording.finish()))
    await deadline(recording.sealForRecovery())
    const closesBeforeLate = state.closes
    state.fault = ''
    state.releases.splice(0).forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 10))
    if (fault === 'create' || fault === 'write') assert.equal(state.closes, closesBeforeLate, 'late writer must not close after timeout')
    assert.deepEqual(await payload(await OpfsPcmRecording.recover(id, 16000)), [1,2,3,4], 'failure must preserve only the committed prefix')
    results.push({ fault, elapsedMs: performance.now() - started, committedPrefixPreserved: true, newWritesRejected: true, shutdownBounded: true })
    await OpfsPcmRecording.acknowledgeRecovery(id)
  }
  state.fault = 'create'
  await assert.rejects(deadline(OpfsPcmRecording.create('metadata-hang', 16000)), {name: 'TimeoutError'})
  state.fault = ''; state.releases.splice(0).forEach(resolve => resolve())
  console.log(JSON.stringify({passed: true, note: 'Production 30s deadlines accelerated to 40ms only in test bundle; abort intentionally never resolves.', results}, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
