const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { buildSync } = require('esbuild')
const ts = require('typescript')
const code = buildSync({ entryPoints: ['src/renderer/src/features/capture/recording/buffered-writer.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const moduleResult = { exports: {} }; new Function('module', 'exports', 'require', code)(moduleResult, moduleResult.exports, require)
const { BufferedPcmWriter, pcmRecordingBufferLimits } = moduleResult.exports
let timerId = 0
const timers = new Map()
global.window = { setTimeout: callback => { timers.set(++timerId, callback); return timerId }, clearTimeout: id => timers.delete(id) }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
async function check(rate, stalledSeconds, remote = false) {
  const limits = pcmRecordingBufferLimits(rate, remote)
  const pressure = [], writes = [], expected = []
  let release
  const held = new Promise(resolve => { release = resolve })
  const writer = new BufferedPcmWriter(async bytes => { writes.push(new Uint8Array(bytes)); if (writes.length === 1) await held }, active => pressure.push(active), error => { throw error }, limits.batchBytes, limits.maximumPendingBytes)
  let sequence = 0
  const push = byteLength => { const bytes = new Uint8Array(byteLength).fill(sequence++); expected.push(bytes); writer.push(bytes.buffer) }
  push(limits.batchBytes)
  for (let second = 0; second < stalledSeconds; second++) push(rate * 2)
  assert.deepEqual(pressure, stalledSeconds >= 8 ? [true] : [], 'short stalls must not pause capture at any sample rate')
  release(); await flush()
  await writer.closeAndDrain()
  if (stalledSeconds >= 8) assert.deepEqual(pressure, [true, false], 'sustained stalls pause and resume when writes catch up')
  assert.equal(writes.length, 2, 'the backlog catches up in one write instead of replaying small batches')
  assert.deepEqual(Buffer.concat(writes.map(bytes => Buffer.from(bytes))), Buffer.concat(expected.map(bytes => Buffer.from(bytes))), 'every accepted audio byte is preserved in order')
}
function preview() {
  const hook = readFileSync('src/renderer/src/features/app/hooks/useAppController.ts', 'utf8')
  const start = hook.indexOf('          const maximumPreviewSamples =')
  const end = hook.indexOf('\n        }', start)
  const source = 'liveDiarizationChunksRef.current.push(samples);\n' + hook.slice(start, end)
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const ref = current => ({ current })
  const context = { sampleRateRef: ref(48000), liveDiarizationChunksRef: ref([]), liveDiarizationHeadRef: ref(0), liveDiarizationSamplesRef: ref(0), liveDiarizationStartSampleRef: ref(0) }
  const push = new Function(...Object.keys(context), 'samples', js)
  for (let frame = 0; frame < 48000 * 120 / 128; frame++) push(...Object.values(context), new Float32Array(128).fill(frame))
  const remaining = context.liveDiarizationChunksRef.current.slice(context.liveDiarizationHeadRef.current)
  assert.ok(context.liveDiarizationSamplesRef.current <= 48000 * 45)
  assert.equal(context.liveDiarizationStartSampleRef.current + context.liveDiarizationSamplesRef.current, 48000 * 120)
  assert.equal(remaining.reduce((sum, frame) => sum + frame.length, 0), context.liveDiarizationSamplesRef.current)
  assert.equal(remaining[0][0], context.liveDiarizationStartSampleRef.current / 128)
  assert.equal(remaining.at(-1)[0], 48000 * 120 / 128 - 1)
}
(async () => {
  for (const rate of [16000, 48000, 96000]) { await check(rate, 3); await check(rate, 8) }
  await check(48000, 3, true); await check(48000, 8, true)
  preview()
  console.log('Recording buffer passed: sample-rate-independent short/sustained stalls, pause/resume, byte-perfect catch-up, and two-minute live preview retention.')
})().catch(error => { console.error(error); process.exitCode = 1 })
