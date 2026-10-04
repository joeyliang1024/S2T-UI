const { existsSync, readFileSync, statSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { modelsRoot } = require('./model-paths.cjs')
const { readWavSamples, resampleMono } = require('./sherpa-diarization.cjs')

const defaultChecksum = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
const modelPath = () => process.env.S2T_SILERO_VAD_MODEL || join(modelsRoot(), 'silero-vad', 'silero_vad.onnx')
let sessionPromise

// Status validation reads and hashes the whole model file. Doing that on every
// VAD request was pure overhead, so keep it until the file itself changes.
let statusCache
const computeStatus = (path) => {
  if (!existsSync(path)) return { available: false, reason: `找不到 Silero VAD 模型：${path}`, path }
  const actualChecksum = createHash('sha256').update(readFileSync(path)).digest('hex')
  const expectedChecksum = process.env.S2T_SILERO_VAD_SHA256 || defaultChecksum
  if (actualChecksum !== expectedChecksum) return { available: false, reason: 'Silero VAD 模型 checksum 不符，拒絕載入', path, actualChecksum, expectedChecksum }
  try { require.resolve('onnxruntime-node') } catch { return { available: false, reason: '缺少 onnxruntime-node，無法執行 Silero VAD', path, actualChecksum, expectedChecksum } }
  return { available: true, path, checksum: actualChecksum }
}

const modelStatus = () => {
  const path = modelPath()
  let stat = null
  try { stat = statSync(path) } catch { stat = null }
  const key = stat ? `${path}|${stat.mtimeMs}|${stat.size}` : path
  if (statusCache?.key === key) return statusCache.value
  const value = computeStatus(path)
  statusCache = { key, value }
  return value
}

const getSession = async () => {
  const status = modelStatus()
  if (!status.available) throw new Error(status.reason)
  if (!sessionPromise) {
    // Do not create ONNX Runtime telemetry state in the container's working
    // directory. Model health/latency is exported by the gateway instead.
    process.env.ORT_DISABLE_TELEMETRY_EVENTS = '1'
    const ort = require('onnxruntime-node')
    // Silero is a tiny recurrent model: extra intra-op threads only add
    // synchronization overhead and contend with the sherpa worker.
    sessionPromise = ort.InferenceSession.create(status.path, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 1 }).catch((error) => { sessionPromise = undefined; throw error })
  }
  return sessionPromise
}

// The upstream opset-16 model is streaming: it carries a 2×1×128 recurrent
// state between frames and expects **the 64-sample tail of the previous window
// in front of each 512-sample window** (576 samples total, as the official
// Python/C++ wrappers do). Feeding a bare 512 samples runs cleanly but the
// recurrent state never tracks speech, so every probability collapses to
// ~0.003: the API then reports "no speech" for everything. That silently drops
// every caption chunk when Silero VAD is enabled in the UI, and it would veto
// every voiceprint block if `S2T_VOICEPRINT_VAD=1` were turned on.
const WINDOW_SAMPLES = 512
const CONTEXT_SAMPLES = 64
const analyzeSamples = async (samples, { threshold = .5, minSpeechMs = 120, minSilenceMs = 300, includeProbabilities = false } = {}) => {
  const status = modelStatus()
  if (!status.available) throw new Error(status.reason)
  const sanitizedThreshold = Math.max(.05, Math.min(.95, Number(threshold) || .5))
  const session = await getSession()
  const ort = require('onnxruntime-node')
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  let context = new Float32Array(CONTEXT_SAMPLES)
  const frameCount = samples.length > 0 ? Math.ceil(samples.length / WINDOW_SAMPLES) : 0
  // One float per 32 ms frame instead of one object: an hour of audio is
  // 112 500 frames, and allocating plus serialising them was measurable.
  const probabilities = new Float32Array(frameCount)
  for (let offset = 0, index = 0; offset < samples.length; offset += WINDOW_SAMPLES, index += 1) {
    // A fresh buffer per call: onnxruntime may keep the reference while the
    // inference runs, so reusing one would mutate the tensor under the run.
    const frame = new Float32Array(WINDOW_SAMPLES + CONTEXT_SAMPLES)
    frame.set(context, 0)
    frame.set(samples.subarray(offset, Math.min(offset + WINDOW_SAMPLES, samples.length)), CONTEXT_SAMPLES)
    const output = await session.run({ input: new ort.Tensor('float32', frame, [1, WINDOW_SAMPLES + CONTEXT_SAMPLES]), state, sr: new ort.Tensor('int64', BigInt64Array.of(16_000n), []) })
    probabilities[index] = Number(output.output.data[0])
    state = output.stateN
    context = frame.slice(-CONTEXT_SAMPLES)
  }
  const minimumSpeech = Math.max(32, Number(minSpeechMs) || 120)
  const minimumSilence = Math.max(32, Number(minSilenceMs) || 300)
  const frameMs = (index) => ({ startMs: Math.round(index * WINDOW_SAMPLES / 16), endMs: Math.round(Math.min((index + 1) * WINDOW_SAMPLES, samples.length) / 16) })
  const speech = []; let start = null; let silenceStart = null
  for (let index = 0; index < probabilities.length; index += 1) {
    const { startMs, endMs } = frameMs(index)
    if (probabilities[index] >= sanitizedThreshold) {
      if (start === null) start = startMs
      silenceStart = null
      continue
    }
    if (start === null) continue
    if (silenceStart === null) silenceStart = startMs
    if (endMs - silenceStart >= minimumSilence) {
      if (silenceStart - start >= minimumSpeech) speech.push({ startMs: start, endMs: silenceStart })
      start = null; silenceStart = null
    }
  }
  if (start !== null && samples.length / 16 - start >= minimumSpeech) speech.push({ startMs: start, endMs: Math.round(samples.length / 16) })
  const durationMs = Math.round(samples.length / 16)
  const result = { sampleRate: 16_000, durationMs, speech }
  // Frame probabilities are useful for debugging but expensive to ship across
  // the worker boundary, so they are opt-in.
  if (includeProbabilities) {
    result.probabilities = Array.from({ length: probabilities.length }, (_, index) => ({ ...frameMs(index), probability: probabilities[index] }))
  }
  return result
}

const analyzeWav = async (audio, options = {}) => {
  const wave = readWavSamples(audio)
  return analyzeSamples(resampleMono(wave.samples, wave.sampleRate, 16_000), options)
}

module.exports = { modelPath, modelStatus, analyzeWav, analyzeSamples, defaultChecksum }
