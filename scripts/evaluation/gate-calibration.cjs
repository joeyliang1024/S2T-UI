#!/usr/bin/env node
// 閘門規則校準（不送 ASR，快速）：把 EnergyVad 切出的每個 chunk 用 Silero
// 逐視窗打分，並用句級 TSV 標注該 chunk 是否含真語音（與語句區間的重疊比），
// 然後離線比對多組「否決規則」的：
//   - 誤殺率：含語音（overlapFrac > 0.15）的 chunk 被否決 → 字幕漏字
//   - 攔截率：純 BGM（overlapFrac == 0）的 chunk 被否決 → 避免幻覺
// 目標：找出「兩素材誤殺 = 0 且攔截率最高」的規則，給放版閘門用。
//
//   node scripts/evaluation/gate-calibration.cjs [--audio path] [--tsv path]
//        [--max-seconds N] [--out experiment/silero-vad-chunking/gate-calibration-2026-10-12]
//
// 輸出：逐 chunk CSV（含各統計量與標注）＋console 規則混淆表。
const { spawnSync } = require('node:child_process')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { buildSync } = require('esbuild')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const audioPath = arg('audio', path.join('music', "我花了半年 20 萬，終於做出這個可以自動上字幕的網站what'sub！｜壹加壹.mp3"))
const tsvPath = arg('tsv', path.join('music', "我花了半年 20 萬，終於做出這個可以自動上字幕的網站what'sub！｜壹加壹_句級Speaker時間軸.tsv"))
const maxSeconds = Number(arg('max-seconds', '300')) || 0
const outDir = arg('out', path.join('experiment', 'silero-vad-chunking', 'gate-calibration-2026-10-12'))
const material = path.basename(audioPath).replace(/\.mp3$/, '').slice(0, 12).replace(/[^\w一-龥]/g, '') || 'material'

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
const { createSileroScorer } = require(path.join(__dirname, 'silero-probabilities.cjs'))

const decodeAudio = (sampleRate) => {
  const ffmpeg = require('ffmpeg-static')
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', audioPath, '-f', 'f32le', '-ac', '1', '-ar', String(sampleRate), '-'], { maxBuffer: 1024 * 1024 * 1024 })
  if (decoded.status !== 0) throw new Error(`ffmpeg 解碼失敗: ${decoded.stderr?.toString().slice(0, 300)}`)
  const bytes = Buffer.from(decoded.stdout)
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  return maxSeconds ? samples.subarray(0, Math.min(samples.length, Math.floor(sampleRate * maxSeconds))) : samples
}

const loadSentences = () => {
  const lines = readFileSync(tsvPath, 'utf8').replace(/^﻿/, '').trim().split('\n').slice(1)
  return lines.map((line) => {
    const [start, end, speaker, ...text] = line.split('\t')
    return { startMs: Math.round(Number(start) * 1_000), endMs: Math.round(Number(end) * 1_000), text: text.join('\t') }
  }).filter((sentence) => Number.isFinite(sentence.startMs) && Number.isFinite(sentence.endMs) && sentence.text && (!maxSeconds || sentence.startMs < maxSeconds * 1_000))
}

// 與評測閘門同語意的「最長連續語音 run」（起/止雙閾值遲滯，每窗 32 ms）
const longestRunMs = (windows, onset, hold) => {
  let run = 0
  let best = 0
  for (const probability of windows) {
    run = probability >= (run > 0 ? hold : onset) ? run + 32 : 0
    if (run > best) best = run
  }
  return best
}

const presets = {
  new: { vadConfig: { ...defaultVadConfig } },
  fast: { vadConfig: { minSpeechMs: 120, minSilenceMs: 150, preRollMs: 300, noiseFloorOffsetDb: 12, chunkMinMs: 700, chunkMaxMs: 1_200 } }
}

const main = async () => {
  const samples48k = decodeAudio(48_000)
  const samples16k = decodeAudio(16_000)
  const sentences = loadSentences()
  console.log(`素材: ${material} | ${Math.round(samples48k.length / 48_000)}s | TSV ${sentences.length} 句`)
  const probabilities = await (await createSileroScorer()).probabilities16k(samples16k)
  mkdirSync(outDir, { recursive: true })

  for (const [presetName, preset] of Object.entries(presets)) {
    const records = []
    global.window = { setTimeout, s2t: { hasModelApiKey: async () => true, transcribeAudioChunk: async () => ({ text: '' }) } }
    const adapter = new OpenAiChunkedModelAdapter({ id: `calib-${presetName}`, endpoint: 'http://127.0.0.1/v1/audio/transcriptions', model: 'calib', requiresApiKey: false, vadConfig: preset.vadConfig })
    // 只錄製切段結果、不真的排隊：真實路徑的 flushPending 受 queuedChunks
    // 上限節流，快推時排隊鏈來不及排空會把切段餓死；stub 掉 enqueue 後
    // 切段完全由 VAD 決定（等價於 ASR 跟得上時的 chunk 流）。
    const originalEnqueue = Object.getPrototypeOf(adapter).enqueue
    adapter.enqueue = function (audio, startSample, isSentenceBoundary) {
      records.push({ startSample, samples: audio.length, startMs: Math.round(startSample / 48_000 * 1_000), endMs: Math.round((startSample + audio.length) / 48_000 * 1_000), isSentenceBoundary: Boolean(isSentenceBoundary) })
      return undefined
    }
    await adapter.start({ sampleRate: 48_000, language: 'zh-TW', targetLanguage: 'en' })
    const batch = Math.round(48_000 * 0.02)
    for (let offset = 0; offset < samples48k.length; offset += batch) adapter.pushAudio(samples48k.subarray(offset, Math.min(offset + batch, samples48k.length)), offset)
    await adapter.stop()

    const rows = records.map((record) => {
      const fromWindow = Math.ceil(record.startSample * 16_000 / 48_000 / 512)
      const toWindow = Math.floor((record.startSample + record.samples) * 16_000 / 48_000 / 512)
      const windows = probabilities.subarray(fromWindow, Math.max(fromWindow, toWindow))
      const overlapMs = sentences.reduce((sum, sentence) => sum + Math.max(0, Math.min(record.endMs, sentence.endMs) - Math.max(record.startMs, sentence.startMs)), 0)
      const audioMs = record.endMs - record.startMs
      const top = [...windows].sort((left, right) => right - left).slice(0, 5)
      return {
        ...record,
        audioMs,
        overlapMs,
        overlapFrac: Math.round(overlapMs / audioMs * 100) / 100,
        maxP: windows.length ? Math.round(Math.max(...windows) * 100) / 100 : 0,
        run5035: longestRunMs(windows, 0.5, 0.35),
        run5025: longestRunMs(windows, 0.5, 0.25),
        run3525: longestRunMs(windows, 0.35, 0.25),
        top5Mean: Math.round(top.reduce((sum, value) => sum + value, 0) / top.length * 100) / 100
      }
    })

    const csv = ['preset,startMs,endMs,audioMs,isSentenceBoundary,overlapFrac,maxP,run5035,run5025,run3525,top5Mean',
      ...rows.map((row) => [presetName, row.startMs, row.endMs, row.audioMs, row.isSentenceBoundary, row.overlapFrac, row.maxP, row.run5035, row.run5025, row.run3525, row.top5Mean].join(','))]
    writeFileSync(path.join(outDir, `gate-${material}-${presetName}.csv`), csv.join('\n') + '\n')

    const speech = rows.filter((row) => row.overlapFrac > 0.15)
    const nonSpeech = rows.filter((row) => row.overlapFrac === 0)
    const ambiguous = rows.length - speech.length - nonSpeech.length
    const rules = {
      'R1 現行 run(.5/.35)≥120': (row) => row.run5035 >= 120,
      'R2 run(.5/.25)≥120': (row) => row.run5025 >= 120,
      'R3 run(.35/.25)≥120': (row) => row.run3525 >= 120,
      'R4 maxP≥.35': (row) => row.maxP >= 0.35,
      'R5 maxP≥.25': (row) => row.maxP >= 0.25,
      'R6 run(.5/.35)≥64': (row) => row.run5035 >= 64,
      'R7 run(.35/.25)≥64': (row) => row.run3525 >= 64,
      'R8 短chunk(<900ms)用R5,否則R1': (row) => (row.audioMs < 900 ? row.maxP >= 0.25 : row.run5035 >= 120),
      'R9 短chunk(<900ms)用R4,否則R1': (row) => (row.audioMs < 900 ? row.maxP >= 0.35 : row.run5035 >= 120),
      'R10 <300ms豁免,否則R1': (row) => row.audioMs < 300 || row.run5035 >= 120
    }
    console.log(`\n=== ${presetName} | chunk ${rows.length}（語音 ${speech.length} / 模糊 ${ambiguous} / 純BGM ${nonSpeech.length}） ===`)
    console.log('規則                          誤殺(語音被否決)  攔截(純BGM被否決)  模糊被否決')
    for (const [label, rule] of Object.entries(rules)) {
      const killedSpeech = speech.filter((row) => !rule(row)).length
      const killedNonSpeech = nonSpeech.filter((row) => !rule(row)).length
      const killedAmbiguous = ambiguous - (rows.filter((row) => row.overlapFrac > 0 && row.overlapFrac <= 0.15).filter((row) => !rule(row)).length)
      console.log(`${label.padEnd(28)} ${String(killedSpeech).padStart(4)}/${speech.length}        ${String(killedNonSpeech).padStart(4)}/${nonSpeech.length}        ${killedAmbiguous}`)
    }
    // 被誤殺的語音 chunk 的統計量分布（找可分離性）
    const falseKills = speech.filter((row) => row.run5035 < 120)
    if (falseKills.length) {
      const values = (key) => falseKills.map((row) => row[key]).sort((left, right) => left - right)
      const pick = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
      const maxSorted = values('maxP'), run35Sorted = values('run3525'), top5Sorted = values('top5Mean')
      console.log(`現行規則誤殺的 ${falseKills.length} 個語音 chunk：maxP p50 ${pick(maxSorted, .5)} / p95 ${pick(maxSorted, .95)} | run3525 p50 ${pick(run35Sorted, .5)} | top5Mean p50 ${pick(top5Sorted, .5)}`)
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
