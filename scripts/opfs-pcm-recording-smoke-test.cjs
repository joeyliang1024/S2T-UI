const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({ entryPoints: ['src/renderer/src/shared/services/opfs-pcm-recording.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('opfs-pcm-recording-smoke-module')
loaded.filename = 'opfs-pcm-recording-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { OpfsPcmRecording } = loaded.exports

const store = { bytes: new Uint8Array(0), position: 0, removed: false }
const writable = {
  async write(value) {
    if (value && value.type === 'seek') { store.position = value.position; return }
    const input = value instanceof ArrayBuffer ? new Uint8Array(value) : value
    const needed = store.position + input.byteLength
    if (needed > store.bytes.length) { const next = new Uint8Array(needed); next.set(store.bytes); store.bytes = next }
    store.bytes.set(input, store.position); store.position += input.byteLength
  },
  async close() {}, async abort() {}
}
const file = { async createWritable() { return writable }, async getFile() { return new Blob([store.bytes], { type: 'audio/wav' }) } }
const directory = { async getFileHandle() { return file }, async getDirectoryHandle() { return this }, async removeEntry() { store.removed = true } }
Object.defineProperty(global, 'navigator', { configurable: true, value: { storage: { async getDirectory() { return directory } } } })

const main = async () => {
  const recording = await OpfsPcmRecording.create('fixture', 16_000)
  assert.ok(recording)
  await recording.append(new Uint8Array([1, 2, 3, 4]).buffer)
  const output = await recording.finish()
  const data = new Uint8Array(await output.arrayBuffer())
  assert.equal(new TextDecoder().decode(data.slice(0, 4)), 'RIFF')
  assert.equal(new DataView(data.buffer).getUint32(40, true), 4)
  assert.deepEqual([...data.slice(44)], [1, 2, 3, 4])
  const recovered = await OpfsPcmRecording.recover('fixture', 16_000)
  assert.ok(recovered)
  const recoveredData = new Uint8Array(await recovered.arrayBuffer())
  assert.equal(new DataView(recoveredData.buffer).getUint32(40, true), 4)
  assert.deepEqual([...recoveredData.slice(44)], [1, 2, 3, 4])
  await recording.discard()
  assert.equal(store.removed, true)
  console.log('OPFS PCM recording smoke test passed.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
