// Native sherpa-onnx inference is synchronous and CPU-bound.  Keep it out of
// the HTTP event loop: this worker owns its own lazy model instances.
const { parentPort } = require('node:worker_threads')
const sherpa = require('./sherpa-diarization.cjs')
const nemotron = require('./nemotron-diarization.cjs')
const silero = require('./silero-vad.cjs')
const preprocess = require('./audio-preprocess.cjs')

const operations = {
  assessVoiceprintSample: ({ audio }) => sherpa.assessVoiceprintSample(audio),
  extractSpeakerEmbedding: ({ audio }) => sherpa.extractSpeakerEmbedding(audio),
  extractSpeakerBlocks: ({ audio, segments }) => sherpa.extractDiarizedSpeakerBlocks(audio, segments),
  speakerLabelEmbeddings: ({ audio, segments }) => sherpa.extractSpeakerLabelEmbeddings(audio, segments),
  diarizeWav: ({ audio, backend }) => backend === 'nemotron-3-diarization' ? nemotron.diarizeWav(audio) : sherpa.diarizeWav(audio),
  nemotronStatus: () => nemotron.verifyRuntime(),
  sileroVad: ({ audio, options }) => silero.analyzeWav(audio, options),
  sileroStatus: () => silero.modelStatus(),
  // A status check only verifies the model file and package. Run one tiny
  // inference as the health probe so a bad ONNX graph/provider is reported
  // before it silently disables VAD for the first recording.
  sileroWarmup: async () => {
    const status = silero.modelStatus()
    if (!status.available) throw new Error(status.reason || 'Silero VAD 模型不可用')
    await silero.analyzeSamples(new Float32Array(512))
    return status
  },
  dynaudnorm: ({ audio }) => preprocess.dynaudnormWav(audio),
  audioPreprocessStatus: () => ({ sileroVad: silero.modelStatus(), dynaudnorm: preprocess.dynaudnormStatus() })
}

// Retained recordings. The gateway clones a recording into this thread once
// and reuses it for the follow-up jobs of the same request; eviction here is
// always recoverable because the gateway re-sends the audio when it gets
// AUDIO_MISSING.
const audioCache = new Map()
const envPositive = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
const pruneAudioCache = () => {
  const now = Date.now()
  const ttlMs = envPositive('S2T_SHERPA_AUDIO_TTL_MS', 300_000)
  const maxEntries = envPositive('S2T_SHERPA_AUDIO_CACHE_ENTRIES', 4)
  const maxBytes = envPositive('S2T_SHERPA_AUDIO_CACHE_MB', 1_024) * 1_048_576
  let bytes = 0
  for (const [id, entry] of audioCache) {
    if (now - entry.usedAt > ttlMs) { audioCache.delete(id); continue }
    bytes += entry.buffer.length
  }
  const oldest = [...audioCache.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt)
  while (oldest.length > maxEntries || bytes > maxBytes) {
    const entry = oldest.shift()
    if (!entry) break
    bytes -= entry[1].buffer.length
    audioCache.delete(entry[0])
  }
}
const resolveAudio = (payload) => {
  if (payload.audio) {
    const buffer = Buffer.isBuffer(payload.audio) ? payload.audio : Buffer.from(payload.audio)
    if (payload.audioId) { audioCache.set(payload.audioId, { buffer, usedAt: Date.now() }); pruneAudioCache() }
    return buffer
  }
  const entry = payload.audioId ? audioCache.get(payload.audioId) : undefined
  if (entry) { entry.usedAt = Date.now(); return entry.buffer }
  throw Object.assign(new Error('worker 已遺失該音訊的快取'), { code: 'AUDIO_MISSING' })
}

// Infer the audio seconds actually processed so the pool can report a real
// RTF per operation instead of a guess.
const durationMsOf = (value) => {
  if (value && Number.isFinite(value.durationMs)) return value.durationMs
  if (!Array.isArray(value) || !value.length) return undefined
  let durationMs = 0
  for (const item of value) {
    if (Number.isFinite(item?.end)) durationMs = Math.max(durationMs, Number(item.end) * 1_000)
    else if (Array.isArray(item?.blocks)) durationMs += item.blocks.reduce((sum, block) => sum + (Number(block?.durationMs) || 0), 0)
    else if (Number.isFinite(item?.durationMs)) durationMs += item.durationMs
  }
  return durationMs || undefined
}

// Ops that return a bare embedding have no duration in their result; read it
// from the WAV header so the pool can still report a real RTF.
const payloadDurationMs = (audio) => {
  try {
    if (!audio || audio.length < 44 || audio.toString('latin1', 0, 4) !== 'RIFF' || audio.toString('latin1', 8, 16) !== 'WAVEfmt ') return undefined
    const channels = Math.max(1, audio.readUInt16LE(22))
    const sampleRate = audio.readUInt32LE(24)
    const bits = audio.readUInt16LE(34) || 16
    if (sampleRate < 1_000 || sampleRate > 384_000) return undefined
    return Math.round((audio.length - 44) / (sampleRate * channels * (bits / 8)) * 1_000)
  } catch { return undefined }
}

parentPort.on('message', async ({ id, operation, payload }) => {
  try {
    const handler = operations[operation]
    if (!handler) throw new Error(`未知 sherpa worker 工作：${operation}`)
    // Structured clone restores Node Buffers as Uint8Array. Convert only at
    // the worker boundary so the native WAV reader keeps its Buffer contract;
    // a retained recording is resolved from the local cache instead.
    const normalized = payload && (payload.audio || payload.audioId) ? { ...payload, audio: resolveAudio(payload) } : payload
    const value = await handler(normalized || {})
    parentPort.postMessage({ id, value, meta: { durationMs: durationMsOf(value) ?? (normalized?.audio ? payloadDurationMs(normalized.audio) : undefined) } })
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, code: error instanceof Error ? error.code : undefined } })
  }
})
