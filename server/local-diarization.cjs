const { existsSync } = require('node:fs')
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
const localDiarizationProfiles = () => {
  const { modelPaths } = require('./sherpa-diarization.cjs')
  const sherpa = modelPaths()
  const nemo = nemotronPaths()
  return [
    { model: 'sherpa-onnx-speaker-diarization', available: existsSync(sherpa.segmentation) && existsSync(sherpa.embedding) },
    { model: NEMOTRON_MODEL, available: existsSync(nemo.model) && existsSync(nemo.runtime) }
  ].filter(profile => profile.available).map(profile => ({ id: `local-${profile.model}`, name: profile.model, model: profile.model, endpoint: '/api/diarizations', configured: true }))
}
const resolveLocalDiarizationModel = (requested) => {
  const model = requested || localModelName()
  if (!localDiarizationProfiles().some(profile => profile.model === model)) throw new Error('本機講者分離模型不存在或 runtime 不完整')
  return model
}
module.exports = { NEMOTRON_MODEL, localModelName, nemotronPaths, localDiarizationProfiles, resolveLocalDiarizationModel }
