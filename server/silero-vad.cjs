const { existsSync, readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { readWavSamples, resampleMono } = require('./sherpa-diarization.cjs')

const defaultChecksum = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
const modelPath = () => process.env.S2T_SILERO_VAD_MODEL || join(process.cwd(), 'models', 'silero-vad', 'silero_vad.onnx')
let sessionPromise

const modelStatus = () => {
  const path = modelPath()
  if (!existsSync(path)) return { available: false, reason: `找不到 Silero VAD 模型：${path}`, path }
  const actualChecksum = createHash('sha256').update(readFileSync(path)).digest('hex')
  const expectedChecksum = process.env.S2T_SILERO_VAD_SHA256 || defaultChecksum
  if (actualChecksum !== expectedChecksum) return { available: false, reason: 'Silero VAD 模型 checksum 不符，拒絕載入', path, actualChecksum, expectedChecksum }
  try { require.resolve('onnxruntime-node') } catch { return { available: false, reason: '缺少 onnxruntime-node，無法執行 Silero VAD', path, actualChecksum, expectedChecksum } }
  return { available: true, path, checksum: actualChecksum }
}

const getSession = async () => {
  const status = modelStatus()
  if (!status.available) throw new Error(status.reason)
  if (!sessionPromise) {
    // Do not create ONNX Runtime telemetry state in the container's working
    // directory. Model health/latency is exported by the gateway instead.
    process.env.ORT_DISABLE_TELEMETRY_EVENTS = '1'
    const ort = require('onnxruntime-node')
    sessionPromise = ort.InferenceSession.create(status.path, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }).catch((error) => { sessionPromise = undefined; throw error })
  }
  return sessionPromise
}

// The upstream opset-16 model is streaming: it consumes exactly 512 samples
// at 16 kHz and carries a 2×1×128 recurrent state between frames.
const analyzeWav = async (audio, { threshold = .5, minSpeechMs = 120, minSilenceMs = 300 } = {}) => {
  const status = modelStatus()
  if (!status.available) throw new Error(status.reason)
  const sanitizedThreshold = Math.max(.05, Math.min(.95, Number(threshold) || .5))
  const wave = readWavSamples(audio)
  const samples = resampleMono(wave.samples, wave.sampleRate, 16_000)
  const session = await getSession()
  const ort = require('onnxruntime-node')
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  const probabilities = []
  for (let offset = 0; offset < samples.length; offset += 512) {
    const frame = new Float32Array(512)
    frame.set(samples.subarray(offset, Math.min(offset + 512, samples.length)))
    const output = await session.run({ input: new ort.Tensor('float32', frame, [1, 512]), state, sr: new ort.Tensor('int64', BigInt64Array.of(16_000n), []) })
    probabilities.push({ startMs: Math.round(offset / 16), endMs: Math.round(Math.min(offset + 512, samples.length) / 16), probability: Number(output.output.data[0]) })
    state = output.stateN
  }
  const minimumSpeech = Math.max(32, Number(minSpeechMs) || 120)
  const minimumSilence = Math.max(32, Number(minSilenceMs) || 300)
  const speech = []; let start = null; let silenceStart = null
  for (const frame of probabilities) {
    if (frame.probability >= sanitizedThreshold) {
      if (start === null) start = frame.startMs
      silenceStart = null
      continue
    }
    if (start === null) continue
    if (silenceStart === null) silenceStart = frame.startMs
    if (frame.endMs - silenceStart >= minimumSilence) {
      if (silenceStart - start >= minimumSpeech) speech.push({ startMs: start, endMs: silenceStart })
      start = null; silenceStart = null
    }
  }
  if (start !== null && samples.length / 16 - start >= minimumSpeech) speech.push({ startMs: start, endMs: Math.round(samples.length / 16) })
  return { sampleRate: 16_000, durationMs: Math.round(samples.length / 16), speech, probabilities }
}

module.exports = { modelPath, modelStatus, analyzeWav, defaultChecksum }
