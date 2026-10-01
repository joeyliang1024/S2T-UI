const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { logger } = require('./logger.cjs')

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
const assessVoiceprintSample = (audio) => {
  const wave = readWavSamples(audio)
  const durationMs = Math.round(wave.samples.length / wave.sampleRate * 1000)
  if (durationMs < 3_000) throw new Error('聲紋錄音至少需要 3 秒的清楚人聲')
  let energy = 0; let clipped = 0
  for (const sample of wave.samples) { energy += sample * sample; if (Math.abs(sample) >= 0.995) clipped += 1 }
  const rmsDbfs = 20 * Math.log10(Math.max(Math.sqrt(energy / Math.max(1, wave.samples.length)), 1e-8))
  if (rmsDbfs < -45) throw new Error('聲紋錄音音量過低，請靠近麥克風後重新錄製')
  if (clipped / wave.samples.length > 0.02) throw new Error('聲紋錄音削波過多，請降低麥克風音量後重新錄製')
  return { durationMs, rmsDbfs: Math.round(rmsDbfs * 10) / 10 }
}

const modelPaths = () => {
  const root = process.env.S2T_SHERPA_MODELS_DIR || join(process.cwd(), 'models', 'sherpa-onnx')
  return {
    segmentation: process.env.S2T_SHERPA_SEGMENTATION_MODEL || join(root, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.int8.onnx'),
    embedding: process.env.S2T_SHERPA_EMBEDDING_MODEL || join(root, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx')
  }
}

// Threads per sherpa model. Workers × threads must stay inside the Pod CPU
// budget, otherwise parallel jobs fight each other and every job slows down.
const inferThreads = () => {
  const value = Number.parseInt(process.env.S2T_SHERPA_INFER_THREADS || '', 10)
  return Number.isInteger(value) && value > 0 ? value : 2
}

let diarizer
let embeddingExtractor

/**
 * Agglomerative clustering cut-off for anonymous speaker labels: higher merges
 * more aggressively (fewer speakers), lower keeps more clusters.
 *
 * The right cut-off depends on how much evidence the recording carries:
 *
 *   - A 45 s live-preview window holds only a handful of segments, so merging
 *     hard glues different people together. On a two-singer duet, 0.8 collapsed
 *     4 of 6 preview windows into ONE speaker (sentence accuracy 65.9%→56.1%).
 *   - A full recording holds dozens-to-hundreds of segments and rewards hard
 *     merging instead (same duet, full track: 71.4%→82.1%).
 *
 * So short inputs keep 0.7 and long inputs use 0.8. Pinning
 * `S2T_SHERPA_CLUSTERING_THRESHOLD` forces a single value for A/B runs. See
 * `npm run diarization:eval:timeline`, §10 of
 * docs/reports/VOICEPRINT_ACCURACY.zh-TW.md, and the preview-window sweep.
 */
const shortAudioSeconds = () => {
  const raw = process.env.S2T_SHERPA_SHORT_AUDIO_SEC
  // `Number('')` is 0 and is finite, which would silently bypass a fallback —
  // so an unset or empty variable must return the default explicitly.
  if (raw === undefined || raw.trim() === '') return 60
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 60
}

/** Single-value override (null when unset, so the length rule applies). */
const clusteringThresholdOverride = () => {
  const raw = process.env.S2T_SHERPA_CLUSTERING_THRESHOLD
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : null
}

const clusteringThresholdFor = (audioSeconds) => {
  const pinned = clusteringThresholdOverride()
  if (pinned !== null) return pinned
  return audioSeconds <= shortAudioSeconds() ? 0.7 : 0.8
}

const clusteringConfigFor = (audioSeconds) => ({ numClusters: 0, threshold: clusteringThresholdFor(audioSeconds) })

const getDiarizer = () => {
  if (diarizer) return diarizer
  const paths = modelPaths()
  if (!existsSync(paths.segmentation) || !existsSync(paths.embedding)) throw new Error('找不到 sherpa-onnx 講者分離模型。請依 docs/guide/SHERPA_ONNX.zh-TW.md 下載模型檔。')
  // Loaded lazily so the Web ASR gateway still starts when this optional native
  // feature is not installed or its models are absent.
  const sherpa = require('sherpa-onnx-node')
  diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: paths.segmentation }, numThreads: inferThreads(), provider: 'cpu' },
    embedding: { model: paths.embedding, numThreads: inferThreads(), provider: 'cpu' },
    clustering: clusteringConfigFor(0), minDurationOn: 0.25, minDurationOff: 0.35
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
  if (!existsSync(embedding)) throw new Error('找不到 sherpa-onnx 聲紋模型。請依 docs/guide/SHERPA_ONNX.zh-TW.md 下載 embedding 模型檔。')
  const sherpa = require('sherpa-onnx-node')
  embeddingExtractor = new sherpa.SpeakerEmbeddingExtractor({ model: embedding, numThreads: inferThreads(), provider: 'cpu' })
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

// Empty-but-present variables must not collapse to 0: `Number('')` is 0 and is
// finite, which would silently bypass the fallback (and did, for the clustering
// threshold).
const envNumber = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}
const envInteger = (name, fallback) => { const value = Number.parseInt(process.env[name] || '', 10); return Number.isInteger(value) && value > 0 ? value : fallback }

/**
 * Bounded inputs for voiceprint matching. Joining an entire meeting into one
 * embedding is both expensive and wrong: a cluster that mixed two people
 * becomes a blended vector. Instead each diarized speaker is cut into a few
 * short blocks so the gateway can require consensus across them.
 */
const voiceprintBlockOptions = () => ({
  minSegmentSec: envNumber('S2T_VOICEPRINT_MIN_SEGMENT_SEC', 1.5),
  minBlockSec: envNumber('S2T_VOICEPRINT_MIN_BLOCK_SEC', 5),
  maxBlockSec: envNumber('S2T_VOICEPRINT_MAX_BLOCK_SEC', 15),
  maxBlocks: envInteger('S2T_VOICEPRINT_MAX_BLOCKS', 3),
  minSpeechSec: envNumber('S2T_VOICEPRINT_MIN_SPEECH_SEC', 8),
  maxSpeechSec: envNumber('S2T_VOICEPRINT_MAX_SPEECH_SEC', 45),
  minDbfs: envNumber('S2T_VOICEPRINT_MIN_BLOCK_DBFS', -45),
  // Optional Silero gate. It only ever runs on the selected blocks, never the
  // whole recording, and stays off unless explicitly requested.
  vad: process.env.S2T_VOICEPRINT_VAD === '1',
  vadMinSpeechRatio: envNumber('S2T_VOICEPRINT_VAD_MIN_RATIO', 0.6)
})

const rmsDbfsOf = (samples) => {
  let energy = 0
  for (let index = 0; index < samples.length; index += 1) energy += samples[index] * samples[index]
  return 20 * Math.log10(Math.max(Math.sqrt(energy / Math.max(1, samples.length)), 1e-8))
}

/**
 * Recording-level veto (default on).
 *
 * The per-block ratio gate stays opt-in (`S2T_VOICEPRINT_VAD=1`), but a
 * recording that contains essentially no speech at all is rejected outright:
 * on music the embedding model scores instrumental passages against an
 * enrolled voice (measured 0.702 on a duet track — above the 0.65 threshold),
 * so labelling it can only produce a wrong identity. Real speech is never
 * that sparse (a conversation is tens of percent voiced), which is why both
 * conditions must hold: a quiet-but-real recording still passes.
 */
const recordingVadOptions = () => ({
  enabled: process.env.S2T_VOICEPRINT_AUDIO_VAD !== '0',
  minVoicedSec: envNumber('S2T_VOICEPRINT_AUDIO_VAD_MIN_SEC', 10),
  minVoicedRatio: envNumber('S2T_VOICEPRINT_AUDIO_VAD_MIN_RATIO', 0.05)
})

const shouldVetoRecording = (voicedSec, durationSec, options) => {
  if (!options.enabled || !(durationSec > 0)) return false
  return voicedSec < options.minVoicedSec && voicedSec / durationSec < options.minVoicedRatio
}

/**
 * Split one speaker's turns into at most `maxBlocks` chronologically ordered
 * blocks, each capped at `maxBlockSec` and never exceeding `maxSpeechSec`
 * total. Short turns and quiet turns are dropped before they can reach the
 * embedding model.
 */
const buildSpeakerBlocks = (parts, options) => {
  const segments = parts.filter((part) => part.duration >= options.minSegmentSec).sort((left, right) => left.start - right.start)
  if (!segments.length || segments.reduce((sum, part) => sum + part.duration, 0) < options.minSpeechSec) return []
  const blocks = []
  let current = []
  let currentSec = 0
  let budgetSec = options.maxSpeechSec
  const flush = () => {
    if (current.length && currentSec >= options.minBlockSec) {
      blocks.push({ segments: current, durationSec: currentSec, startSec: current[0].start, endSec: current[current.length - 1].end })
    }
    current = []; currentSec = 0
  }
  for (const segment of segments) {
    if (budgetSec <= 0 || blocks.length >= options.maxBlocks) break
    // A single continuous turn is sliced as well: one 20 minute monologue
    // must not become one 20 minute embedding input, and slicing it is what
    // makes consensus possible for a speaker who never yields the floor.
    let position = segment.start
    let remaining = Math.min(segment.duration, budgetSec)
    while (remaining > 1e-3) {
      if (blocks.length >= options.maxBlocks) break
      if (currentSec >= options.maxBlockSec) {
        flush()
        if (blocks.length >= options.maxBlocks) break
      }
      const slice = Math.min(remaining, options.maxBlockSec - currentSec, budgetSec)
      if (slice <= 1e-3) break
      current.push({ start: position, end: position + slice, duration: slice })
      currentSec += slice
      position += slice
      remaining -= slice
      budgetSec -= slice
    }
    if (blocks.length >= options.maxBlocks || budgetSec <= 0) break
  }
  if (blocks.length < options.maxBlocks) flush()
  return blocks.slice(0, options.maxBlocks)
}

const joinBlockSamples = (wave, block) => {
  const length = block.segments.reduce((total, segment) => total + Math.max(0, Math.ceil(segment.end * wave.sampleRate) - Math.floor(segment.start * wave.sampleRate)), 0)
  if (length <= 0) return null
  const joined = new Float32Array(length)
  let offset = 0
  for (const segment of block.segments) {
    const start = Math.max(0, Math.floor(segment.start * wave.sampleRate))
    const end = Math.min(wave.samples.length, Math.ceil(segment.end * wave.sampleRate))
    if (end <= start) continue
    joined.set(wave.samples.subarray(start, end), offset)
    offset += end - start
  }
  return offset ? joined.subarray(0, offset) : null
}

// Optional gate: only the selected block is analysed, never the whole file.
const passesVadGate = async (samples, sampleRate, options) => {
  try {
    // Lazy require: silero-vad.cjs imports the WAV helpers from this module.
    const { analyzeSamples } = require('./silero-vad.cjs')
    const result = await analyzeSamples(resampleMono(samples, sampleRate, 16_000))
    const ratio = result.durationMs ? result.speech.reduce((sum, interval) => sum + Math.max(0, interval.endMs - interval.startMs), 0) / result.durationMs : 0
    return ratio >= options.vadMinSpeechRatio
  } catch {
    // An unavailable VAD must not silently reject audio; the energy gate
    // above still applies.
    return true
  }
}

/**
 * Build bounded embeddings for every diarized speaker.
 *
 * Replaces the old "join every turn of this speaker into one embedding":
 * - input is capped per block (default 15 s) and per speaker (default 45 s),
 *   so CPU cost is predictable instead of proportional to meeting length;
 * - quiet turns and turns shorter than 1.5 s never reach the model;
 * - each block is reported separately so the gateway can demand consensus.
 */
const extractDiarizedSpeakerBlocks = async (audio, segments) => {
  const options = voiceprintBlockOptions()
  const wave = readWavSamples(audio)
  const groups = new Map()
  for (const segment of segments) {
    if (!segment || typeof segment.speaker !== 'string' || !segment.speaker.trim()) continue
    const start = Math.max(0, Number(segment.start))
    const end = Math.min(wave.samples.length / wave.sampleRate, Number(segment.end))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const parts = groups.get(segment.speaker) || []
    parts.push({ start, end, duration: end - start })
    groups.set(segment.speaker, parts)
  }
  const output = []
  // One Silero pass over the whole recording (RTF ≈ 0.003) decides whether
  // voiceprint labelling may run at all. It runs here rather than before
  // diarization because the diarized segments are the API's own answer, not
  // part of the voiceprint path.
  const recordingVad = recordingVadOptions()
  let vetoed = false
  if (recordingVad.enabled) {
    try {
      const { analyzeSamples } = require('./silero-vad.cjs')
      const vad = await analyzeSamples(resampleMono(wave.samples, wave.sampleRate, 16_000))
      const voicedSec = vad.speech.reduce((sum, interval) => sum + Math.max(0, interval.endMs - interval.startMs), 0) / 1000
      const durationSec = wave.samples.length / wave.sampleRate
      vetoed = shouldVetoRecording(voicedSec, durationSec, recordingVad)
      if (vetoed) logger.info('voiceprint.decision', { decision: 'reject', reason: 'recording-no-speech', voicedSec: Math.round(voicedSec * 10) / 10, durationSec: Math.round(durationSec * 10) / 10, voicedRatio: Math.round(voicedSec / durationSec * 1000) / 1000 })
    } catch {
      // An unavailable VAD must not silently reject the recording; the energy
      // gate and the decision thresholds still apply.
    }
  }
  for (const [speaker, parts] of groups) {
    const usableSec = parts.filter((part) => part.duration >= options.minSegmentSec).reduce((sum, part) => sum + part.duration, 0)
    if (vetoed) {
      output.push({ speaker, speechMs: Math.round(usableSec * 1_000), blocks: [], vetoed: true })
      continue
    }
    const blocks = buildSpeakerBlocks(parts, options)
    const items = []
    for (const block of blocks) {
      const joined = joinBlockSamples(wave, block)
      if (!joined) continue
      const rmsDbfs = rmsDbfsOf(joined)
      if (rmsDbfs < options.minDbfs) continue
      if (options.vad && !(await passesVadGate(joined, wave.sampleRate, options))) continue
      const startedAt = Date.now()
      try {
        const embedding = extractEmbeddingFromWave({ samples: joined, sampleRate: wave.sampleRate })
        items.push({ index: items.length, startSec: block.startSec, endSec: block.endSec, durationMs: Math.round(block.durationSec * 1_000), rmsDbfs: Math.round(rmsDbfs * 10) / 10, embedding })
        logger.debug('voiceprint.embed', { speaker, block: items.length - 1, inputSec: Math.round(block.durationSec * 10) / 10, ms: Date.now() - startedAt })
      } catch {
        // A short/noisy block stays anonymous; it must not block the rest of
        // the diarization result.
      }
    }
    output.push({ speaker, speechMs: Math.round(usableSec * 1_000), blocks: items })
  }
  return output
}

const diarizeWav = (audio) => {
  const wave = readWavSamples(audio)
  const instance = getDiarizer()
  const samples = resampleMono(wave.samples, wave.sampleRate, instance.sampleRate || 16_000)
  // The clustering cut-off is per call: a live-preview window and the final
  // full-track pass need different values (see clusteringThresholdFor).
  if (typeof instance.setConfig === 'function') instance.setConfig({ clustering: clusteringConfigFor(samples.length / (instance.sampleRate || 16_000)) })
  return instance.process(samples).map((segment) => ({ start: segment.start, end: segment.end, speaker: `SPEAKER_${String(segment.speaker).padStart(2, '0')}` }))
}

module.exports = { diarizeWav, extractSpeakerEmbedding, extractDiarizedSpeakerBlocks, assessVoiceprintSample, modelPaths, readWavSamples, resampleMono, shouldVetoRecording, clusteringThresholdFor }
