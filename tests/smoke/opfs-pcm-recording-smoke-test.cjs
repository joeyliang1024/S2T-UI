const assert = require('node:assert/strict'), { buildSync } = require('esbuild')
const code = buildSync({ entryPoints: ['src/renderer/src/features/capture/recording/adapters/opfs-pcm-recording.ts'], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text
const m = { exports: {} }; new Function('module','exports','require',code)(m,m.exports,require)
const { OpfsPcmRecording } = m.exports
const state = { forbidFullRead: false, failClose: false }
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
  async createWritable() { let staged = new Uint8Array(); const file = this; return { async write(value) { staged = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value) }, async close() { if (state.failClose) { state.failClose = false; throw Error('disk commit failed') }; file.bytes = staged.slice() }, async abort() {} } }
}
const root = new Directory()
Object.defineProperty(global, 'navigator', { configurable: true, value: { language: 'en', languages: ['en'], storage: { getDirectory: async () => root } } })
const payload = async blob => [...new Uint8Array(await blob.arrayBuffer()).slice(44)]
;(async () => {
  const recording = await OpfsPcmRecording.create('fixture', 16000)
  const audio = new Uint8Array([1,2,3,4]); const write = recording.append(audio.buffer); audio.fill(9); await write
  state.forbidFullRead = true
  assert.deepEqual(await payload(await OpfsPcmRecording.recover('fixture',16000)), [1,2,3,4], 'append must commit before finish; accepted bytes are immutable')
  const finished = recording.finish(); assert.equal(recording.finish(), finished, 'finish is idempotent')
  const output = await finished; assert.equal(new DataView(await output.arrayBuffer()).getUint32(40,true), 4)
  await assert.rejects(recording.append(new ArrayBuffer(2)), /closed|關閉|关闭/i)
  await assert.rejects(OpfsPcmRecording.create('fixture',16000), /already exists/)
  await assert.rejects(OpfsPcmRecording.recover('fixture',48000), /metadata/)
  const second = await OpfsPcmRecording.create('second',48000); await second.append(new Uint8Array([5,6]).buffer)
  state.failClose = true; await assert.rejects(second.append(new Uint8Array([7,8]).buffer), /disk commit failed/)
  assert.deepEqual(await payload(await OpfsPcmRecording.recover('second',48000)), [5,6], 'failed final chunk retains committed prefix')
  const dir = await root.getDirectoryHandle('s2t-ui-recordings')
  const legacy = await dir.getFileHandle('legacy.wav',{create:true}); const writer = await legacy.createWritable(); await writer.write(new Uint8Array([...new Uint8Array(44),1,2,3,4]).buffer); await writer.close()
  assert.deepEqual(await payload(await OpfsPcmRecording.recover('legacy',16000)), [1,2,3,4])
  await OpfsPcmRecording.acknowledgeRecovery('fixture'); assert.equal(await OpfsPcmRecording.recover('fixture',16000), null)
  assert.deepEqual(await payload(await OpfsPcmRecording.recover('second',48000)), [5,6], 'ACK isolates other recovery sources')
  await OpfsPcmRecording.acknowledgeRecovery('fixture'); await recording.discard()
  await assert.rejects(OpfsPcmRecording.create('../invalid',16000), /Invalid/)
  console.log('PASS close-committed OPFS chunks, pre-finish recovery, immutable writes, idempotent finish/ACK, failed-tail prefix retention, legacy WAV and isolated cleanup')
})().catch(error => { console.error(error); process.exitCode = 1 })
