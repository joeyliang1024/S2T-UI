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

// Enrollment quality checks happen before loading the embedding model so an
// unusable sample never creates a vector or a compensation record. They are
// intentionally conservative: users can re-record a quiet sample rather than
// silently training an unreliable identity.

module.exports = { readWavSamples, resampleMono }
