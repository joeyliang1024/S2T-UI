const { existsSync } = require('node:fs')
const { join } = require('node:path')

// This module deliberately has no Python or ffmpeg dependency. sherpa-onnx
// expects mono, 16 kHz Float32 PCM, so WAV decoding/downsampling happens here.
const readWavSamples = (audio) => {
  if (audio.length < 44 || audio.subarray(0, 4).toString() !== 'RIFF' || audio.subarray(8, 12).toString() !== 'WAVE') throw new Error('僅支援 PCM WAV 音檔')
  let offset = 12; let format; let data
  while (offset + 8 <= audio.length) {
    const id = audio.subarray(offset, offset + 4).toString(); const size = audio.readUInt32LE(offset + 4); const start = offset + 8
    if (id === 'fmt ') format = { code: audio.readUInt16LE(start), channels: audio.readUInt16LE(start + 2), sampleRate: audio.readUInt32LE(start + 4), bits: audio.readUInt16LE(start + 14) }
    if (id === 'data') { data = audio.subarray(start, Math.min(start + size, audio.length)); break }
    offset = start + size + (size % 2)
  }
  if (!format || !data || format.channels < 1 || !format.sampleRate) throw new Error('WAV 缺少必要的 fmt 或 data 區段')
  if (format.code !== 1 || format.bits !== 16) throw new Error('sherpa-onnx 本機講者分離目前只支援 PCM 16-bit WAV')
  const frames = Math.floor(data.length / (2 * format.channels)); const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < format.channels; channel += 1) sum += data.readInt16LE((frame * format.channels + channel) * 2) / 32768
    mono[frame] = sum / format.channels
  }
  return { samples: mono, sampleRate: format.sampleRate }
}

const resampleMono = (samples, sourceRate, targetRate = 16_000) => {
  if (sourceRate === targetRate) return samples
  const output = new Float32Array(Math.max(1, Math.round(samples.length * targetRate / sourceRate)))
  const scale = sourceRate / targetRate
  for (let index = 0; index < output.length; index += 1) {
    const position = index * scale; const left = Math.floor(position); const right = Math.min(left + 1, samples.length - 1); const fraction = position - left
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction
  }
  return output
}

const modelPaths = () => {
  const root = process.env.S2T_SHERPA_MODELS_DIR || join(process.cwd(), 'models', 'sherpa-onnx')
  return {
    segmentation: process.env.S2T_SHERPA_SEGMENTATION_MODEL || join(root, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx'),
    embedding: process.env.S2T_SHERPA_EMBEDDING_MODEL || join(root, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx')
  }
}

let diarizer
let embeddingExtractor
const getDiarizer = () => {
  if (diarizer) return diarizer
  const paths = modelPaths()
  if (!existsSync(paths.segmentation) || !existsSync(paths.embedding)) throw new Error('找不到 sherpa-onnx 講者分離模型。請依 docs/SHERPA_ONNX.zh-TW.md 下載模型檔。')
  // Loaded lazily so the Web ASR gateway still starts when this optional native
  // feature is not installed or its models are absent.
  const sherpa = require('sherpa-onnx-node')
  diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: paths.segmentation }, numThreads: 2, provider: 'cpu' },
    embedding: { model: paths.embedding, numThreads: 2, provider: 'cpu' },
    clustering: { numClusters: 0, threshold: 0.5 }, minDurationOn: 0.25, minDurationOff: 0.35
  })
  return diarizer
}

/**
 * Create a normalized 3D-Speaker embedding for a PCM16 WAV recording. The
 * embedding model is shared with diarization but uses sherpa-onnx's dedicated
 * speaker-identification API, so it can be persisted and searched in Milvus.
 */
const getEmbeddingExtractor = () => {
  if (embeddingExtractor) return embeddingExtractor
  const { embedding } = modelPaths()
  if (!existsSync(embedding)) throw new Error('找不到 sherpa-onnx 聲紋模型。請依 docs/SHERPA_ONNX.zh-TW.md 下載 embedding 模型檔。')
  const sherpa = require('sherpa-onnx-node')
  embeddingExtractor = new sherpa.SpeakerEmbeddingExtractor({ model: embedding, numThreads: 2, provider: 'cpu' })
  return embeddingExtractor
}

const extractEmbeddingFromWave = (wave) => {
  const extractor = getEmbeddingExtractor()
  const samples = resampleMono(wave.samples, wave.sampleRate, 16_000)
  // Very short enrollment recordings are unstable regardless of the model.
  if (samples.length < 16_000) throw new Error('聲紋錄音至少需要 1 秒的清楚人聲')
  const stream = extractor.createStream()
  stream.acceptWaveform({ samples, sampleRate: 16_000 })
  stream.inputFinished()
  if (!extractor.isReady(stream)) throw new Error('聲紋模型尚未取得足夠的有效人聲')
  return Array.from(extractor.compute(stream))
}

const extractSpeakerEmbedding = (audio) => extractEmbeddingFromWave(readWavSamples(audio))

/** Build one embedding per diarized speaker by joining that speaker's turns. */
const extractDiarizedSpeakerEmbeddings = (audio, segments) => {
  const wave = readWavSamples(audio)
  const samplesBySpeaker = new Map()
  for (const segment of segments) {
    const start = Math.max(0, Math.floor(segment.start * wave.sampleRate))
    const end = Math.min(wave.samples.length, Math.ceil(segment.end * wave.sampleRate))
    if (end <= start) continue
    const parts = samplesBySpeaker.get(segment.speaker) || []
    parts.push(wave.samples.slice(start, end))
    samplesBySpeaker.set(segment.speaker, parts)
  }
  return [...samplesBySpeaker.entries()].flatMap(([speaker, parts]) => {
    const length = parts.reduce((total, part) => total + part.length, 0)
    if (length < wave.sampleRate) return []
    const joined = new Float32Array(length); let offset = 0
    for (const part of parts) { joined.set(part, offset); offset += part.length }
    try { return [{ speaker, embedding: extractEmbeddingFromWave({ samples: joined, sampleRate: wave.sampleRate }) }] } catch (error) {
      // A short/noisy anonymous speaker should stay anonymous; it must not
      // prevent diarization results for the rest of the meeting.
      return []
    }
  })
}

const diarizeWav = (audio) => {
  const wave = readWavSamples(audio)
  const instance = getDiarizer()
  const samples = resampleMono(wave.samples, wave.sampleRate, instance.sampleRate || 16_000)
  return instance.process(samples).map((segment) => ({ start: segment.start, end: segment.end, speaker: `SPEAKER_${String(segment.speaker).padStart(2, '0')}` }))
}

module.exports = { diarizeWav, extractSpeakerEmbedding, extractDiarizedSpeakerEmbeddings, modelPaths, readWavSamples, resampleMono }
