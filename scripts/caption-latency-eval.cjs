#!/usr/bin/env node
// 端到端即時字幕延遲／準度／碎片化評測：把測試音檔以「真實收音節奏」喂進
// 目前的 EnergyVad + OpenAiChunkedModelAdapter 切段邏輯，chunk 真的送 ASR，
// 用句級 TSV 標準答案計算：
//   - 說話開始 → 字幕上屏 的延遲 P50/P95（目標 ≤ 2500 ms）
//   - CER：整曲語料級 + 逐句平均（準度，逐句以原始 chunk 事件對齊句子區間）
//   - 每句被切成幾段字幕、字幕總行數、合併次數（碎片化）
//
// 準度槓桿（皆不動模型，先在評測層模擬，有效才進產品碼）：
//   - overlapMs：只在強制切段的 payload 前接 N ms 音訊，顯示端前綴去重
//   - sampleRate 16000：Whisper 內部吃 16k，上傳縮 3×
//   - sanitizeAsrText 與滾動上下文 prompt 已在產品碼（model-adapter）實作，
//     本評測自動吃到；滾動 prompt 已判定有效並產品化，不再於 mock 重複模擬
//
//   node scripts/caption-latency-eval.cjs [--preset old,new,newov,new16k]
//                                        [--audio path] [--tsv path]
//                                        [--max-seconds N] [--out eval-reports]
//
// 需要 .env 提供 S2T_ASR_ENDPOINT / S2T_ASR_MODEL / S2T_ASR_API_KEY。
const { spawnSync } = require('node:child_process')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const TARGET_MS = 2_500
const OVERLAP_MS = 600

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const presetNames = arg('preset', 'old,new').split(',').map((value) => value.trim()).filter(Boolean)
const audioPath = arg('audio', path.join('music', '卓文萱 Genie Chuo&曹格 Gary Chaw【梁山伯與茱麗葉】華視偶像劇「戀愛女王」片尾曲 Official Music Video.mp3'))
const tsvPath = arg('tsv', path.join('music', '梁山伯與茱麗葉_句級Speaker時間軸.tsv'))
const maxSeconds = Number(arg('max-seconds', '0')) || 0
const outDir = arg('out', 'eval-reports')

const endpoint = (process.env.S2T_ASR_ENDPOINT || '').trim()
const model = (process.env.S2T_ASR_MODEL || '').trim()
const apiKey = (process.env.S2T_ASR_API_KEY || '').trim()
if (!endpoint || !model) throw new Error('缺少 S2T_ASR_ENDPOINT / S2T_ASR_MODEL，無法進行真實 ASR 測試')

// 與其他 smoke test 相同的做法：esbuild 打包 renderer 的 TS 模組後在 Node 執行，
// 保證評測跑的是 App 真正使用的切段邏輯，而不是重寫的複本。
const loadTs = (entry) => {
  const result = buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', write: false })
  const LoadedModule = module.constructor
  const loaded = new LoadedModule(path.basename(entry))
  loaded.filename = path.resolve(entry) + '.cjs'
  loaded.paths = module.paths
  loaded._compile(result.outputFiles[0].text, loaded.filename)
  return loaded.exports
}
const { OpenAiChunkedModelAdapter } = loadTs(path.join('src', 'renderer', 'src', 'features', 'models', 'model-adapter.ts'))
const { defaultVadConfig } = loadTs(path.join('src', 'renderer', 'src', 'features', 'capture', 'vad.ts'))
const { canMergeHttpCaption } = loadTs(path.join('src', 'renderer', 'src', 'features', 'app', 'services', 'translation-policy.ts'))

// 調整前的舊預設值，用來跟新預設做對照。
// overlapMs/sampleRate 為尚未產品化的準度與延遲槓桿（見檔頭說明）。
const PRESETS = {
  old: { vadConfig: { minSpeechMs: 120, minSilenceMs: 500, preRollMs: 300, noiseFloorOffsetDb: 12, chunkMinMs: 1_000, chunkMaxMs: 2_400 }, overlapMs: 0, sampleRate: 48_000 },
  new: { vadConfig: { ...defaultVadConfig }, overlapMs: 0, sampleRate: 48_000 },
  newov: { vadConfig: { ...defaultVadConfig }, overlapMs: OVERLAP_MS, sampleRate: 48_000 },
  new16k: { vadConfig: { ...defaultVadConfig }, overlapMs: 0, sampleRate: 16_000 }
}

const decodeCache = new Map()
const decodeAudio = (sampleRate) => {
  if (decodeCache.has(sampleRate)) return decodeCache.get(sampleRate)
  const ffmpeg = require('ffmpeg-static')
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', audioPath, '-f', 'f32le', '-ac', '1', '-ar', String(sampleRate), '-'], { maxBuffer: 1024 * 1024 * 1024 })
  if (decoded.status !== 0) throw new Error(`ffmpeg 解碼失敗: ${decoded.stderr?.toString().slice(0, 500)}`)
  const bytes = Buffer.from(decoded.stdout)
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const truncated = maxSeconds ? samples.subarray(0, Math.min(samples.length, Math.floor(sampleRate * maxSeconds))) : samples
  decodeCache.set(sampleRate, truncated)
  return truncated
}

const loadSentences = () => {
  const lines = readFileSync(tsvPath, 'utf8').replace(/^﻿/, '').trim().split('\n').slice(1)
  return lines.map((line) => {
    const [start, end, speaker, ...text] = line.split('\t')
    return { startMs: Math.round(Number(start) * 1_000), endMs: Math.round(Number(end) * 1_000), speaker, text: text.join('\t') }
  }).filter((sentence) => Number.isFinite(sentence.startMs) && Number.isFinite(sentence.endMs) && sentence.text && (!maxSeconds || sentence.startMs < maxSeconds * 1_000))
}

const percentile = (values, value) => {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(value * sorted.length) - 1))])
}
const stats = (values) => ({ n: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.round(Math.max(...values)) : null })
const mean = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null

const normalize = (text) => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
const editDistance = (left, right) => {
  let previous = new Uint32Array(right.length + 1)
  for (let index = 0; index <= right.length; index += 1) previous[index] = index
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint32Array(right.length + 1)
    current[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[right.length]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// PCM16 WAV（與 model-adapter.wavFromFloat32 相同的 44-byte header）
const pcm16FromFloat = (floats) => {
  const pcm = new Int16Array(floats.length)
  for (let index = 0; index < floats.length; index += 1) {
    const value = Math.max(-1, Math.min(1, floats[index]))
    pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return pcm
}
const wavFromPcm16 = (parts, sampleRate) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const buffer = new ArrayBuffer(44 + total * 2)
  const view = new DataView(buffer)
  const write = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, total * 2, true)
  let offset = 44
  for (const part of parts) { new Int16Array(buffer, offset, part.length).set(part); offset += part.length * 2 }
  return buffer
}

// 重疊去重：新文字若以上一段文字的結尾開頭，把重複前綴砍掉（重疊段已上屏過）。
const stripOverlapDuplicate = (previous, next) => {
  if (!previous || !next) return next
  const maximum = Math.min(Math.floor(next.length / 2), 24)
  for (let length = maximum; length >= 2; length -= 1) {
    if (previous.slice(previous.length - length) === next.slice(0, length)) return next.slice(length).replace(/^\s+/, '')
  }
  return next
}

const runPreset = async (name, preset, sentences) => {
  const { vadConfig, overlapMs, sampleRate: sr } = preset
  const samples = decodeAudio(sr)
  const records = [] // enqueue 順序，含被 queue-overflow 丟棄的 chunk
  const events = [] // 所有 transcript/gap 事件＋實際上屏 wall time
  const errors = []
  let pointer = 0
  let startedAtWall = 0
  let lastFinalText = '' // 重疊去重的比對基準

  const realTranscribe = async (request) => {
    const form = new FormData()
    form.append('file', new Blob([request.audio], { type: 'audio/wav' }), 'chunk.wav')
    form.append('model', model)
    if (request.language) form.append('language', request.language)
    // 滾動上下文 prompt 已在產品碼（model-adapter.rollingPrompt）實作，此處只轉送。
    if (request.prompt && request.prompt.trim()) form.append('prompt', request.prompt)
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(20_000) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`ASR ${response.status}: ${payload.error?.message || payload.error || response.statusText}`)
    const text = typeof payload.text === 'string' ? payload.text : ''
    return { text }
  }

  global.window = { setTimeout, s2t: { hasModelApiKey: async () => true, transcribeAudioChunk: realTranscribe } }

  const adapter = new OpenAiChunkedModelAdapter({ id: 'eval-asr', endpoint, model, requiresApiKey: false, vadConfig })
  const originalEnqueue = Object.getPrototypeOf(adapter).enqueue
  const originalRetry = Object.getPrototypeOf(adapter).transcribeWithRetry
  adapter.enqueue = function (audio, startSample, isSentenceBoundary) {
    records.push({
      index: records.length,
      startSample,
      startMs: Math.round(startSample / sr * 1_000),
      endMs: Math.round((startSample + audio.length) / sr * 1_000),
      audioMs: Math.round(audio.length / sr * 1_000),
      isSentenceBoundary: Boolean(isSentenceBoundary),
      dropped: false,
      enqueuedWall: performance.now()
    })
    return originalEnqueue.call(this, audio, startSample, isSentenceBoundary)
  }
  adapter.transcribeWithRetry = async function (audio) {
    while (records[pointer] && records[pointer].dropped) pointer += 1
    const record = records[pointer]
    pointer += 1
    const callStartedAt = performance.now()
    if (record) {
      record.asrStartWall = callStartedAt
      record.queueWaitMs = callStartedAt - record.enqueuedWall
      // 左側重疊只加在強制切段（VAD 自然句界已對齊停頓，不需要）
      if (overlapMs > 0 && !record.isSentenceBoundary && record.startSample > 0) {
        const overlapSamples = Math.floor(sr * overlapMs / 1_000)
        const from = Math.max(0, record.startSample - overlapSamples)
        const prefix = pcm16FromFloat(samples.subarray(from, record.startSample))
        const chunk = new Int16Array(audio, 44)
        audio = wavFromPcm16([prefix, chunk], sr)
        record.payloadMs = Math.round(audio.length - 44) / 2 / sr * 1_000
      }
    }
    try {
      return await originalRetry.call(this, audio)
    } finally {
      if (record) record.asrDurationMs = performance.now() - callStartedAt
    }
  }
  adapter.onTranscript((event) => {
    // queue-overflow 的 gap 在 enqueue 內同步發出，一定是剛入隊的最後一筆。
    if (event.status === 'gap' && event.gapReason === 'queue-overflow' && records.length) records[records.length - 1].dropped = true
    let finalEvent = event
    if (event.status === 'final' && overlapMs > 0) {
      finalEvent = { ...event, sourceText: stripOverlapDuplicate(lastFinalText, event.sourceText) }
      if (finalEvent.sourceText) lastFinalText = finalEvent.sourceText
    }
    events.push({ ...finalEvent, displayWall: performance.now() })
  })
  adapter.onError((message) => errors.push(message))

  await adapter.start({ sampleRate: sr, language: 'zh-TW', targetLanguage: 'en' })
  startedAtWall = performance.now()
  const batch = Math.round(sr * 0.02) // 20 ms 一批，模擬 AudioWorklet 的連續收音
  for (let offset = 0; offset < samples.length; offset += batch) {
    const target = startedAtWall + offset / sr * 1_000
    const remaining = target - performance.now()
    if (remaining > 0) await sleep(remaining)
    adapter.pushAudio(samples.subarray(offset, Math.min(offset + batch, samples.length)), offset)
  }
  await adapter.stop()
  const audioEndWall = performance.now()

  const finals = events.filter((event) => event.status === 'final')
  const findEvent = (record) => events.find((event) => event.startMs === record.startMs && event.endMs === record.endMs)

  // 使用者實際讀到的字幕 = App 端 canMergeHttpCaption 合併後的結果
  const merged = []
  for (const event of finals) {
    const previous = merged[merged.length - 1]
    if (previous && canMergeHttpCaption(previous, event, -1)) {
      merged[merged.length - 1] = { ...previous, endMs: event.endMs, sourceText: previous.sourceText + event.sourceText }
    } else merged.push({ ...event })
  }

  // 逐句 CER 用「原始 chunk 事件」對齊句子區間，避免 merged 長字幕跨多句污染
  const sentenceResults = sentences.map((sentence) => {
    const record = records.find((item) => item.startMs <= sentence.startMs && item.endMs > sentence.startMs)
    const base = { startMs: sentence.startMs, endMs: sentence.endMs, speaker: sentence.speaker, text: sentence.text }
    const overlappingFinals = finals.filter((event) => event.startMs < sentence.endMs && event.endMs > sentence.startMs)
    const hyp = overlappingFinals.map((event) => event.sourceText).join('')
    const overlapping = merged.filter((caption) => caption.startMs < sentence.endMs && caption.endMs > sentence.startMs)
    const reference = normalize(sentence.text)
    const sentenceCer = reference.length ? editDistance(reference, normalize(hyp)) / reference.length : null
    const common = { segments: overlapping.length, hyp, sentenceCerPct: sentenceCer === null ? null : Math.round(sentenceCer * 10_000) / 100 }
    if (!record) return { ...base, status: 'not-sent', ...common }
    if (record.dropped) return { ...base, status: 'dropped', ...common }
    const event = findEvent(record)
    if (!event || event.status !== 'final') return { ...base, status: event?.status === 'gap' ? 'request-failed' : 'empty-text', ...common }
    const displayOffsetMs = Math.round(event.displayWall - startedAtWall)
    return {
      ...base,
      status: 'shown',
      chunkMs: record.audioMs,
      payloadMs: record.payloadMs ? Math.round(record.payloadMs) : null,
      boundary: record.isSentenceBoundary ? 'vad' : 'forced',
      queueWaitMs: Math.round(record.queueWaitMs ?? 0),
      asrMs: Math.round(record.asrDurationMs ?? 0),
      displayOffsetMs,
      latencyMs: displayOffsetMs - sentence.startMs,
      ...common
    }
  })

  // 語料級 CER（整曲標準答案 vs 整曲字幕，時間序拼接）
  const overlapsSentence = (caption) => sentences.some((sentence) => caption.startMs < sentence.endMs && caption.endMs > sentence.startMs)
  const reference = normalize(sentences.map((sentence) => sentence.text).join(''))
  const hypothesis = normalize(merged.filter(overlapsSentence).map((caption) => caption.sourceText).join(''))
  const distance = editDistance(reference, hypothesis)
  const cer = reference.length ? distance / reference.length : null
  // 逐句 CER 字數加權彙總
  const sentenceCerSum = sentenceResults.reduce((sum, result) => {
    const refChars = normalize(result.text).length
    const dist = result.sentenceCerPct === null || refChars === 0 ? 0 : Math.round(result.sentenceCerPct / 100 * refChars)
    return sum + dist
  }, 0)

  const shown = sentenceResults.filter((result) => result.status === 'shown')
  const latencies = shown.map((result) => result.latencyMs)
  const sent = records.filter((record) => !record.dropped && record.asrStartWall !== undefined)
  const segmentsPerSentence = sentenceResults.map((result) => result.segments)
  const report = {
    preset: name,
    vadConfig,
    overlapMs,
    sampleRate: sr,
    audio: audioPath,
    audioSeconds: Math.round(samples.length / sr),
    tsv: tsvPath,
    endpointHost: new URL(endpoint).host,
    model,
    startedAt: new Date().toISOString(),
    chunks: {
      enqueued: records.length,
      sent: sent.length,
      droppedQueue: records.filter((record) => record.dropped).length,
      emptyText: sent.filter((record) => !findEvent(record)).length,
      requestFailed: sent.filter((record) => { const event = findEvent(record); return event && event.status === 'gap' }).length,
      avgAudioMs: records.length ? Math.round(records.reduce((sum, record) => sum + record.audioMs, 0) / records.length) : 0,
      vadBoundaries: records.filter((record) => record.isSentenceBoundary).length,
      forcedBoundaries: records.filter((record) => !record.isSentenceBoundary).length
    },
    asrMs: stats(sent.map((record) => record.asrDurationMs ?? 0)),
    queueWaitMs: stats(sent.map((record) => record.queueWaitMs ?? 0)),
    errors: { count: errors.length, unique: [...new Set(errors)] },
    sentences: {
      total: sentenceResults.length,
      shown: shown.length,
      dropped: sentenceResults.filter((result) => result.status === 'dropped').length,
      emptyText: sentenceResults.filter((result) => result.status === 'empty-text').length,
      requestFailed: sentenceResults.filter((result) => result.status === 'request-failed').length,
      notSent: sentenceResults.filter((result) => result.status === 'not-sent').length
    },
    latencyMs: {
      ...stats(latencies),
      within2500ShownPct: shown.length && latencies.length ? Math.round(latencies.filter((value) => value <= TARGET_MS).length / shown.length * 10_000) / 100 : null,
      within2500AllPct: sentenceResults.length ? Math.round(shown.filter((result) => result.latencyMs <= TARGET_MS).length / sentenceResults.length * 10_000) / 100 : null
    },
    accuracy: {
      corpusCerPct: cer === null ? null : Math.round(cer * 10_000) / 100,
      corpusRefChars: reference.length,
      corpusDistance: distance,
      sentenceCerPct: reference.length ? Math.round(sentenceCerSum / reference.length * 10_000) / 100 : null
    },
    fragmentation: {
      displayedCaptions: merged.length,
      rawFinalEvents: finals.length,
      mergeOperations: finals.length - merged.length,
      meanCaptionChars: mean(merged.map((caption) => normalize(caption.sourceText).length)),
      segmentsPerSentenceMean: mean(segmentsPerSentence),
      segmentsPerSentenceMax: segmentsPerSentence.length ? Math.max(...segmentsPerSentence) : null,
      sentencesSplit: sentenceResults.filter((result) => result.segments > 1).length
    },
    drainMs: Math.round(audioEndWall - startedAtWall - samples.length / sr * 1_000),
    captions: merged.map((caption) => ({ startMs: caption.startMs, endMs: caption.endMs, text: caption.sourceText })),
    detail: sentenceResults
  }
  return report
}

const printSummary = (report) => {
  const { chunks, asrMs, queueWaitMs, sentences, latencyMs, accuracy, fragmentation, errors } = report
  const knobs = `minSilence ${report.vadConfig.minSilenceMs} / chunk ${report.vadConfig.chunkMinMs}-${report.vadConfig.chunkMaxMs} / 滾動prompt(產品) / 重疊 ${report.overlapMs}ms / ${report.sampleRate / 1000}kHz`
  console.log(`\n=== preset ${report.preset} (${knobs}, ${report.audioSeconds}s 音檔) ===`)
  console.log(`chunks: 入隊 ${chunks.enqueued} / 送出 ${chunks.sent} / overflow 丟棄 ${chunks.droppedQueue} / 無文字 ${chunks.emptyText} | VAD句界 ${chunks.vadBoundaries} / 強制 ${chunks.forcedBoundaries} | 平均 ${chunks.avgAudioMs} ms`)
  console.log(`ASR 推論: p50 ${asrMs.p50} ms / p95 ${asrMs.p95} ms / max ${asrMs.max} ms (n=${asrMs.n}) | 排隊 p95 ${queueWaitMs.p95} ms`)
  console.log(`句子: ${sentences.total} 句 → 上屏 ${sentences.shown} / 丟棄 ${sentences.dropped} / 無文字 ${sentences.emptyText} / 失敗 ${sentences.requestFailed} / 未送出 ${sentences.notSent}`)
  console.log(`延遲(說話→上屏): p50 ${latencyMs.p50} ms / p95 ${latencyMs.p95} ms / max ${latencyMs.max} ms | ≤${TARGET_MS}ms: 已上屏 ${latencyMs.within2500ShownPct}% / 全部 ${latencyMs.within2500AllPct}%`)
  console.log(`準度: 語料CER ${accuracy.corpusCerPct}% (${accuracy.corpusDistance}/${accuracy.corpusRefChars}) | 逐句CER ${accuracy.sentenceCerPct}%`)
  console.log(`碎片化: 字幕 ${fragmentation.displayedCaptions} 行 (原始事件 ${fragmentation.rawFinalEvents} → 合併 ${fragmentation.mergeOperations} 次) | 平均 ${fragmentation.meanCaptionChars} 字/行 | 每句 ${fragmentation.segmentsPerSentenceMean} 段 (max ${fragmentation.segmentsPerSentenceMax}, 被切開 ${fragmentation.sentencesSplit} 句) | ASR 錯誤 ${errors.count}`)
  console.log(`最慢 3 句:`)
  report.detail.filter((result) => result.status === 'shown').sort((left, right) => right.latencyMs - left.latencyMs).slice(0, 3)
    .forEach((result) => console.log(`  [${result.latencyMs} ms] t=${(result.startMs / 1000).toFixed(2)}s ${result.text} (chunk ${result.chunkMs}ms/${result.boundary}, asr ${result.asrMs}ms, CER ${result.sentenceCerPct}%)`))
  const worstCer = report.detail.filter((result) => result.sentenceCerPct !== null).sort((left, right) => right.sentenceCerPct - left.sentenceCerPct).slice(0, 3)
  worstCer.forEach((result) => console.log(`  [CER ${result.sentenceCerPct}%] 標準: ${result.text} | 字幕: ${result.hyp || '(空)'}`))
}

const main = async () => {
  console.log(`ASR: ${new URL(endpoint).host} / model=${model} | 音檔: ${path.basename(audioPath)}${maxSeconds ? ` (前 ${maxSeconds}s)` : ''}`)
  const sentences = loadSentences()
  console.log(`TSV ${sentences.length} 句 | preset: ${presetNames.join(', ')}`)
  mkdirSync(outDir, { recursive: true })
  const reports = []
  for (const name of presetNames) {
    const preset = PRESETS[name]
    if (!preset) throw new Error(`未知 preset: ${name}（可用：${Object.keys(PRESETS).join('/')}）`)
    const report = await runPreset(name, preset, sentences)
    writeFileSync(path.join(outDir, `caption-latency-${name}${maxSeconds ? `-${maxSeconds}s` : ''}.json`), JSON.stringify(report, null, 2))
    printSummary(report)
    reports.push(report)
  }
  if (reports.length > 1) {
    console.log('\n=== 對比 ===')
    const header = ['preset', '重疊', 'sr', 'chunks', 'ASR p95', '延遲 p50', '延遲 p95', `≤${TARGET_MS}ms`, '逐句CER', '語料CER', '字幕行', '句/段', '被切句']
    const rows = reports.map((report) => [
      report.preset,
      `${report.overlapMs}ms`,
      `${report.sampleRate / 1000}k`,
      `${report.chunks.sent}/${report.chunks.enqueued}`,
      `${report.asrMs.p95}ms`,
      `${report.latencyMs.p50}ms`,
      `${report.latencyMs.p95}ms`,
      `${report.latencyMs.within2500AllPct}%`,
      `${report.accuracy.sentenceCerPct}%`,
      `${report.accuracy.corpusCerPct}%`,
      report.fragmentation.displayedCaptions,
      report.fragmentation.segmentsPerSentenceMean,
      report.fragmentation.sentencesSplit
    ])
    const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => String(row[index]).length)))
    console.log(header.map((cell, index) => cell.padEnd(widths[index])).join('  '))
    rows.forEach((row) => console.log(row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
