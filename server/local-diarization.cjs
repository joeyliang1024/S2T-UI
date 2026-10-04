const { join } = require('node:path')
const { modelsRoot } = require('./model-paths.cjs')
const NEMOTRON_MODEL = 'nemotron-3-diarization'
const localModelName = (env = process.env) => {
  const name = (env.S2T_DIARIZATION_MODEL || '').trim()
  if (!name || name === 'sherpa-onnx-speaker-diarization') return 'sherpa-onnx-speaker-diarization'
  if ([NEMOTRON_MODEL, 'nvidia/Nemotron-3-Diarization'].includes(name)) return NEMOTRON_MODEL
  throw new Error('本機 S2T_DIARIZATION_MODEL 不支援此模型；遠端模型請同時設定 S2T_DIARIZATION_ENDPOINT')
}
const nemotronPaths = (root = process.cwd()) => {
  const directory = join(modelsRoot(process.env, root), 'nemotron-3-diarization')
  return { model: join(directory, 'Nemotron-3-Diarization.q8_0.gguf'),
    runtime: join(directory, 'runtime', `${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'nemo-speech.exe' : 'nemo-speech') }
}
module.exports = { NEMOTRON_MODEL, localModelName, nemotronPaths }
