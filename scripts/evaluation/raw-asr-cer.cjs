#!/usr/bin/env node
// 素材的「純 ASR 誤差分解」：把 fixture 的每個 clip 直接送 ASR（不經 VAD
// 切段、字幕歸因、滾動 prompt），量測 ASR 本體在這素材上的 CER/WER。
// 與管線對照只作診斷：逐 clip ASR 使用完整句子與不同上下文，兩者
// CER 差值不是可加減的因果誤差分解，也不是 main branch baseline。
// 可分別檢查：
//   - 純 ASR 誤差（模型/語言/提示詞問題 → 查 ASR 端）
//   - 管線誤差（切段/歸因/合併 → 查評測層與切段邏輯）
//
//   node scripts/evaluation/raw-asr-cer.cjs [--clips-tsv path] [--sr 48000]
//        [--limit 0=全跑] [--prompt "文字提示"] [--concurrency 4]
const { readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { createHash } = require('node:crypto')
require('dotenv').config({ path: path.join(__dirname, '..', '..', 'backend', '.env') })

const { corpusRates, sentenceRates } = require(path.join(__dirname, 'text-metrics.cjs'))

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const clipsTsv = arg('clips-tsv', path.join('music', 'taiwan-tongues', 'fixture-300s.clips.tsv'))
const sr = Number(arg('sr', '48000'))
const limit = Number(arg('limit', '0'))
const prompt = arg('prompt', '')
const concurrency = Number(arg('concurrency', '4'))
if (!Number.isInteger(sr) || sr <= 0 || !Number.isInteger(limit) || limit < 0 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error('sr、concurrency 必須為正整數；limit 必須為非負整數')
const clipsDir = path.join(path.dirname(clipsTsv), 'clips')

const endpoint = (process.env.S2T_ASR_ENDPOINT || '').trim()
const model = (process.env.S2T_ASR_MODEL || '').trim()
const apiKey = (process.env.S2T_ASR_API_KEY || '').trim()
if (!endpoint || !model) throw new Error('缺少 S2T_ASR_ENDPOINT / S2T_ASR_MODEL')

const ffmpeg = path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg')

// 與評測同構的 WAV (s16) 編碼
const wavFromFloat32 = (samples, sampleRate) => {
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples.length * 2, 4); wav.write('WAVE', 8)
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index += 1) {
    wav.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(samples[index] * 32_767))), 44 + index * 2)
  }
  return wav
}

const decode = (clipId) => {
  const source = path.join(clipsDir, `${clipId}.mp3`)
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', source, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'], { maxBuffer: 64 * 1024 * 1024 })
  if (decoded.status !== 0) throw new Error(`解碼失敗: ${clipId}`)
  const bytes = Buffer.from(decoded.stdout)
  return wavFromFloat32(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), sr)
}

const transcribe = async (wav) => {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav')
  form.append('model', model)
  // 與 model-adapter 同行為：zh-TW → zh（split('-')[0]）
  form.append('language', 'zh')
  if (prompt) form.append('prompt', prompt)
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(30_000) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`ASR ${response.status}: ${payload.error?.message || response.statusText}`)
  return typeof payload.text === 'string' ? payload.text : ''
}

const main = async () => {
  const rows = readFileSync(clipsTsv, 'utf8').trim().split('\n').slice(1)
    .map((line) => { const [text, clip] = line.split('\t'); return { text, clip } })
    .filter((row) => row.text && row.clip)
  const selected = limit > 0 ? rows.slice(0, limit) : rows
  console.log(`純 ASR 直測：${selected.length} clips @ ${sr}Hz${prompt ? ` / prompt「${prompt}」` : ' / 無 prompt'}`)

  const results = new Array(selected.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < selected.length) {
      const index = nextIndex
      nextIndex += 1
      const row = selected[index]
      try {
        const wav = decode(row.clip)
        const startedAt = performance.now()
        results[index] = { ...row, hyp: await transcribe(wav), asrMs: performance.now() - startedAt }
      } catch (error) {
        results[index] = { ...row, hyp: '', error: String(error.message || error) }
      }
      if ((index + 1) % 25 === 0) console.log(`  ${index + 1}/${selected.length}`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  const refCorpus = results.map((row) => row.text).join('')
  const hypCorpus = results.map((row) => row.hyp).join('')
  const corpus = corpusRates(refCorpus, hypCorpus)
  const failures = results.filter((row) => row.error)
  const empty = results.filter((row) => !row.hyp && !row.error)
  const durations = results.filter(row => Number.isFinite(row.asrMs)).map(row => row.asrMs).sort((a, b) => a - b)
  const percentile = fraction => durations.length ? Math.round(durations[Math.ceil(durations.length * fraction) - 1]) : null
  const latencyMs = { n: durations.length, p50: percentile(.5), p95: percentile(.95), max: durations.length ? Math.round(durations[durations.length - 1]) : null }
  console.log(`\n純 ASR 語料CER ${(corpus.cer * 100).toFixed(2)}% (${corpus.cerDistance}/${corpus.refChars}字) | 語料WER ${(corpus.wer * 100).toFixed(2)}% (${corpus.werDistance}/${corpus.refWords}詞)`)
  console.log(`失敗 ${failures.length} / 空回應 ${empty.length}`)
  console.log(`ASR HTTP 延遲（不含解碼、不是字幕上屏延遲）：p50 ${latencyMs.p50}ms / p95 ${latencyMs.p95}ms`)
  const worst = results.map((row) => ({ ...row, cer: sentenceRates(row.text, row.hyp).cer ?? 1 }))
    .sort((left, right) => right.cer - left.cer).slice(0, 15)
  for (const row of worst) {
    console.log(`  [CER ${(row.cer * 100).toFixed(1)}%] 標準: ${row.text} | ASR: ${row.hyp}${row.error ? ` (${row.error})` : ''}`)
  }
  const baseName = clipsTsv.replace(/(?:\.clips)?\.tsv$/, '')
  const outFile = arg('out', `${baseName}-raw-asr-sr${sr}${prompt ? '-prompt' : ''}.json`)
  if (path.resolve(outFile) === path.resolve(clipsTsv)) throw new Error('輸出不得覆寫 clips TSV')
  writeFileSync(outFile, JSON.stringify({ sr, prompt, corpus, latencyMs, endpointHost: new URL(endpoint).host, model, clipsTsvSha256: createHash('sha256').update(readFileSync(clipsTsv)).digest('hex'), failures: failures.length, empty: empty.length, results }, null, 1))
  console.log(`明細 → ${outFile}`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
