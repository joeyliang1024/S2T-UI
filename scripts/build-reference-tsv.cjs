#!/usr/bin/env node
// 產生句級標準答案 TSV（無人工逐字稿時的替代方案）：
//   1. 用 repo 內的 Silero VAD（server/silero-vad.cjs，獨立於評測對象 EnergyVad）
//      偵測語音區間 → 句級 start/end（「開始說話」的客觀定義）
//   2. 每個區間整段送 ASR（完整上下文、不經切段）→ 參考文字
// 參考文字來自同一模型的整段解碼，只適合跨 preset 的「相對」比較，
// 不宣稱是人工標準答案。
//
//   node scripts/build-reference-tsv.cjs [--audio path] [--out path]
//        [--max-seconds N] [--min-silence 600] [--concurrency 4]
//
// 需要 .env 提供 S2T_ASR_ENDPOINT / S2T_ASR_MODEL / S2T_ASR_API_KEY。
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const audioPath = arg('audio', path.join('music', "我花了半年 20 萬，終於做出這個可以自動上字幕的網站what'sub！｜壹加壹.mp3"))
const maxSeconds = Number(arg('max-seconds', '0')) || 0
const minSilenceMs = Number(arg('min-silence', '600')) || 600
const concurrency = Math.max(1, Math.min(8, Number(arg('concurrency', '4')) || 4))
const outPath = arg('out', audioPath.replace(/\.[^.]+$/, '_句級Speaker時間軸.tsv'))

const endpoint = (process.env.S2T_ASR_ENDPOINT || '').trim()
const model = (process.env.S2T_ASR_MODEL || '').trim()
const apiKey = (process.env.S2T_ASR_API_KEY || '').trim()
if (!endpoint || !model) throw new Error('缺少 S2T_ASR_ENDPOINT / S2T_ASR_MODEL')

const SR = 16_000
const MAX_REFERENCE_SEGMENT_MS = 25_000 // 保譴：超長區間切開，避免解碼退化
const sanitizeText = (text) => text.replace(/<\|[^|]*\|>/g, ' ').replace(/\|\|/g, ' ').replace(/\s+/g, ' ').trim()

const decode = () => {
  const ffmpeg = require('ffmpeg-static')
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', audioPath, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1024 * 1024 * 1024 })
  if (decoded.status !== 0) throw new Error(`ffmpeg 解碼失敗: ${decoded.stderr?.toString().slice(0, 500)}`)
  const bytes = Buffer.from(decoded.stdout)
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  return maxSeconds ? samples.subarray(0, Math.min(samples.length, Math.floor(SR * maxSeconds))) : samples
}

const wavFromFloat = (floats) => {
  const buffer = new ArrayBuffer(44 + floats.length * 2)
  const view = new DataView(buffer)
  const write = (offset, text) => { for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index)) }
  write(0, 'RIFF'); view.setUint32(4, 36 + floats.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, SR, true); view.setUint32(28, SR * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, floats.length * 2, true)
  for (let index = 0; index < floats.length; index += 1) {
    const value = Math.max(-1, Math.min(1, floats[index]))
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
  }
  return buffer
}

const transcribe = async (wav) => {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    try {
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'reference.wav')
      form.append('model', model)
      form.append('language', 'zh')
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`ASR ${response.status}: ${payload.error?.message || payload.error || response.statusText}`)
      return sanitizeText(typeof payload.text === 'string' ? payload.text : '')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

const main = async () => {
  const startedAt = Date.now()
  const samples = decode()
  console.log(`解碼 ${Math.round(samples.length / SR)}s | Silero minSilence=${minSilenceMs}ms | 併發 ${concurrency}`)
  const { analyzeSamples } = require(path.join(__dirname, '..', 'server', 'silero-vad.cjs'))
  const { speech } = await analyzeSamples(samples, { threshold: 0.5, minSpeechMs: 150, minSilenceMs })
  // 超長區間切開；太短的清脆雜訊丟棄
  const segments = []
  for (const interval of speech) {
    if (interval.endMs - interval.startMs < 250) continue
    let start = interval.startMs
    while (interval.endMs - start > MAX_REFERENCE_SEGMENT_MS) {
      segments.push({ startMs: start, endMs: start + MAX_REFERENCE_SEGMENT_MS })
      start += MAX_REFERENCE_SEGMENT_MS
    }
    segments.push({ startMs: start, endMs: interval.endMs })
  }
  console.log(`Silero 偵測 ${speech.length} 個語音區間 → 參考段 ${segments.length} 段（前 ${Math.round(samples.length / SR)}s）`)

  const texts = new Array(segments.length).fill('')
  const failures = []
  let cursor = 0
  let done = 0
  const worker = async () => {
    while (cursor < segments.length) {
      const index = cursor
      cursor += 1
      const segment = segments[index]
      const from = Math.max(0, Math.floor(segment.startMs * SR / 1_000))
      const to = Math.min(samples.length, Math.ceil(segment.endMs * SR / 1_000) + Math.floor(SR * 0.1))
      try {
        texts[index] = await transcribe(wavFromFloat(samples.subarray(from, to)))
      } catch (error) {
        failures.push({ index, error: error instanceof Error ? error.message : String(error) })
      }
      done += 1
      if (done % 25 === 0 || done === segments.length) console.log(`  進度 ${done}/${segments.length}（失敗 ${failures.length}，${Math.round((Date.now() - startedAt) / 1000)}s）`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  const lines = ['start\tend\tspeaker\ttext']
  let written = 0
  segments.forEach((segment, index) => {
    const text = texts[index]
    if (!text) return
    written += 1
    lines.push(`${(segment.startMs / 1_000).toFixed(3)}\t${(segment.endMs / 1_000).toFixed(3)}\treference\t${text}`)
  })
  writeFileSync(outPath, `${lines.join('\n')}\n`)
  console.log(`完成：${written}/${segments.length} 段有文字，失敗 ${failures.length}，耗時 ${Math.round((Date.now() - startedAt) / 1_000)}s`)
  console.log(`TSV 已寫入：${outPath}`)
  if (failures.length) console.log('失敗段:', JSON.stringify(failures.slice(0, 5)))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
