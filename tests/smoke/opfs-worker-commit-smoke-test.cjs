const assert = require('node:assert/strict'), vm = require('node:vm'), { buildSync } = require('esbuild')
const code = buildSync({ entryPoints: ['frontend/src/features/capture/recording/adapters/opfs-write.worker.ts'], bundle: true, platform: 'browser', format: 'iife', write: false }).outputFiles[0].text
const run = async (request, replies = []) => {
  const context = { TextEncoder, Uint8Array, Number, Error, JSON, postMessage: reply => replies.push(reply) }
  vm.createContext(context); vm.runInContext(code, context)
  context.onmessage({ data: request })
  for (let i = 0; i < 100 && !replies.length; i++) await Promise.resolve()
  return replies[0]
}
const file = (maximumWrite = Infinity, failFlush = false) => {
  let bytes = Buffer.alloc(0), closed = 0, flushed = 0
  return { get bytes() { return bytes }, get closed() { return closed }, get flushed() { return flushed }, async createSyncAccessHandle() { return {
    write(value, { at }) { const count = Math.min(maximumWrite, value.length); if (bytes.length < at + count) bytes = Buffer.concat([bytes, Buffer.alloc(at + count - bytes.length)]); Buffer.from(value).copy(bytes, at, 0, count); return count },
    truncate(size) { bytes = bytes.subarray(0,size) }, flush() { if (failFlush) throw Error('disk flush failed'); flushed++ }, close() { closed++ }
  } } }
}
;(async () => {
  const audio = new Uint8Array([1,2,3,4,5,6]).buffer
  const pcm = file(2), commit = file(3)
  assert.ok((await run({ id: 1, file: pcm, commit, audio })).committed)
  assert.deepEqual(pcm.bytes, Buffer.from(audio)); assert.equal(JSON.parse(commit.bytes.toString()).bytes, 6)
  assert.equal(pcm.flushed, 1); assert.equal(commit.flushed, 1); assert.equal(pcm.closed, 1); assert.equal(commit.closed, 1)
  const failedPcm = file(2, true), untouchedCommit = file()
  assert.match((await run({ id: 2, file: failedPcm, commit: untouchedCommit, audio })).error, /flush failed/)
  assert.equal(untouchedCommit.bytes.length, 0, 'failed audio must never publish a durable marker')
  assert.equal(failedPcm.closed, 1)
  assert.ok((await run({ id: 3, file: {}, commit: {}, audio })).unsupported)
  const zeroWrite = file(0), zeroCommit = file()
  assert.match((await run({ id: 4, file: zeroWrite, commit: zeroCommit, audio })).error, /Incomplete/)
  assert.equal(zeroCommit.bytes.length, 0)
  console.log('PASS OPFS worker partial writes, flush-before-marker ordering, failure cleanup, zero-progress protection and unsupported fallback')
})().catch(error => { console.error(error); process.exitCode = 1 })
