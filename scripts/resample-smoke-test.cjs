const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')

const result = buildSync({
  entryPoints: ['src/renderer/src/features/capture/resample.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false
})
const LoadedModule = module.constructor
const loaded = new LoadedModule('resample-smoke-module')
loaded.filename = 'resample-smoke-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { StreamingResampler, chooseModelSampleRate } = loaded.exports

const samples = (size) => Float32Array.from({ length: size }, (_, index) => Math.sin(index / 17))
for (const [sourceRate, targetRate] of [[48_000, 16_000], [44_100, 16_000], [48_000, 48_000]]) {
  const input = samples(sourceRate * 2)
  const onceResampler = new StreamingResampler(sourceRate, targetRate)
  const once = onceResampler.process(input)
  const onceFinal = Float32Array.from([...once, ...onceResampler.flush()])
  const streaming = new StreamingResampler(sourceRate, targetRate)
  const parts = []
  for (let offset = 0; offset < input.length; offset += 127) parts.push(streaming.process(input.slice(offset, offset + 127)))
  parts.push(streaming.flush())
  const split = Float32Array.from(parts.flatMap((part) => [...part]))
  assert.ok(Math.abs(onceFinal.length - Math.round(input.length * targetRate / sourceRate)) <= 1, `${sourceRate} -> ${targetRate}: output length`)
  assert.equal(split.length, onceFinal.length, `${sourceRate} -> ${targetRate}: chunking changed output length`)
  for (let index = 0; index < split.length; index += 1) assert.ok(Math.abs(split[index] - onceFinal[index]) < .0001, `${sourceRate} -> ${targetRate}: chunking changed sample ${index}`)
}
assert.equal(chooseModelSampleRate(48_000, [16_000, 44_100]), 44_100)
assert.equal(chooseModelSampleRate(44_100, [16_000]), 16_000)
assert.equal(chooseModelSampleRate(48_000, []), 48_000)
console.log('Resampler smoke test passed.')
