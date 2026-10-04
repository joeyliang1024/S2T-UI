const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { modelsRoot } = require('../../server/model-paths.cjs')
const { nemotronPaths } = require('../../server/local-diarization.cjs')
const { modelPaths } = require('../../server/sherpa-diarization.cjs')
const { modelPath } = require('../../server/silero-vad.cjs')
const names = ['S2T_MODELS_DIR', 'S2T_SHERPA_MODELS_DIR', 'S2T_SHERPA_SEGMENTATION_MODEL', 'S2T_SHERPA_EMBEDDING_MODEL', 'S2T_SILERO_VAD_MODEL']
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
try {
  for (const name of names) delete process.env[name]
  const segmentation = root => join(root, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx')
  const embedding = root => join(root, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx')
  assert.equal(modelsRoot({}, '/app'), '/app/models')
  assert.equal(modelsRoot({ S2T_MODELS_DIR: ' assets ' }, '/app'), '/app/assets')
  assert.equal(modelsRoot({ S2T_MODELS_DIR: ' ' }, '/app'), '/app/models')
  assert.equal(modelPaths().segmentation, segmentation(join(process.cwd(), 'models/sherpa-onnx')))
  process.env.S2T_MODELS_DIR = '/mounted/models'
  assert.deepEqual(modelPaths(), { segmentation: segmentation('/mounted/models/sherpa-onnx'), embedding: embedding('/mounted/models/sherpa-onnx') })
  assert.equal(modelPath(), '/mounted/models/silero-vad/silero_vad.onnx')
  assert.equal(nemotronPaths().model, '/mounted/models/nemotron-3-diarization/Nemotron-3-Diarization.q8_0.gguf')
  assert.ok(nemotronPaths().runtime.startsWith('/mounted/models/nemotron-3-diarization/runtime/'))
  process.env.S2T_SHERPA_MODELS_DIR = '/legacy/sherpa'
  assert.equal(modelPaths().segmentation, segmentation('/legacy/sherpa'))
  assert.equal(modelPath(), '/mounted/models/silero-vad/silero_vad.onnx', 'legacy sherpa must not affect Silero')
  process.env.S2T_SHERPA_SEGMENTATION_MODEL = '/explicit/seg.onnx'
  process.env.S2T_SHERPA_EMBEDDING_MODEL = '/explicit/embed.onnx'
  process.env.S2T_SILERO_VAD_MODEL = '/explicit/vad.onnx'
  assert.deepEqual(modelPaths(), { segmentation: '/explicit/seg.onnx', embedding: '/explicit/embed.onnx' })
  assert.equal(modelPath(), '/explicit/vad.onnx')
  assert.ok(nemotronPaths().model.startsWith('/mounted/models/'), 'file overrides must not affect Nemotron')
  console.log('Shared roots, relative/default roots, legacy compatibility and all per-file override priorities passed.')
} finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] } }
