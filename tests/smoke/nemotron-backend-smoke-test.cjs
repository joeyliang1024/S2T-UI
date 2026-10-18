const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const source = fs.readFileSync(path.resolve('server/nemotron-diarization.cjs'), 'utf8')
const load = (env, doctor) => {
  const commands = [], m = { exports: {} }
  const mockedRequire = name => {
    if (name === 'node:fs') return { ...fs, mkdtempSync: () => '/tmp/mock-nemo', writeFileSync: () => {}, readFileSync: p => p === 'model' ? Buffer.from('fixture') : '', rmSync: () => {}, accessSync: () => {} }
    if (name === 'node:crypto') return { createHash: () => ({ update() { return this }, digest: () => '08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1' }) }
    if (name === 'node:child_process') return { execFileSync: (_file, args, options) => { commands.push({ args, options }); return args[0] === 'doctor' ? JSON.stringify(doctor) : '' } }
    if (name === './local-diarization.cjs') return { nemotronPaths: () => ({ runtime: '/mock/cuda/nemo-speech', model: 'model' }) }
    if (name === './sherpa-diarization.cjs') return { readWavSamples: () => ({ samples: new Float32Array(512), sampleRate: 16000 }), resampleMono: x => x }
    if (name === './logger.cjs') return { logger: { error() {} } }
    if (name === './inference-config.cjs') return require('../../server/inference-config.cjs')
    return require(name)
  }
  new Function('require', 'module', 'exports', 'process', source)(mockedRequire, m, m.exports, { env, platform: 'linux', arch: 'x64' })
  return { ...m.exports, commands }
}
const cuda = load({ S2T_INFERENCE_BACKEND: 'cuda' }, { features: { backend_cuda: true }, accelerator_available: true, driver_runtime_compatible: true, devices: [{ type: 'gpu' }, { type: 'gpu' }] })
cuda.diarizeWav(Buffer.alloc(0))
const inference = cuda.commands.find(item => item.args[0] === 'diarize')
assert.equal(inference.args[inference.args.indexOf('--backend') + 1], 'cuda:0')
assert.equal(inference.args[inference.args.indexOf('--diar.chunk') + 1], '264', 'GPU switch preserves validated geometry')
assert.throws(() => load({ S2T_INFERENCE_BACKEND: 'cuda' }, { features: { backend_cuda: false } }).verifyRuntime(), /未編入 CUDA/)
const cpu = load({}, {})
cpu.diarizeWav(Buffer.alloc(0))
assert.ok(!cpu.commands.some(item => item.args[0] === 'doctor'), 'default CPU needs no CUDA runtime')
assert.equal(cpu.commands.find(item => item.args[0] === 'diarize').args[5], 'cpu')
console.log('PASS Nemotron backend: explicit CUDA device, diagnostic rejection, default CPU and unchanged geometry')
