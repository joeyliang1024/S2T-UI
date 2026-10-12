#!/usr/bin/env node
// 把 Taiwan-Tongues-ASR-CE（Common Voice zh-TW 逐句朗讀）test set 拼成
// caption-latency-eval.cjs 可吃的「音檔＋句級 TSV」素材：
//   - 固定種子抽樣，累積到 --seconds（預設 300s）
//   - 句間插入 --gap 秒靜音（預設 0.6s > EnergyVad minSilence，讓 VAD
//     能在句間切界；句區間標註只含 clip 本體不含靜音）
//   - 輸出 fixture-{seconds}s.wav (48k mono s16) 與 fixture-{seconds}s.tsv
//
//   node scripts/evaluation/build-taiwan-tongues-fixture.cjs [--seconds 300] [--gap 0.6]
const { readFileSync, writeFileSync, readdirSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { createHash } = require('node:crypto')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const totalSeconds = Number(arg('seconds', '300'))
const gapSeconds = Number(arg('gap', '0.6'))
// Keep the dataset's original sentence boundaries by default. Grouping is
// a different audio fixture, not a correction for corpus-level CER.
const groupChars = Number(arg('group-chars', '0'))
if (!Number.isFinite(totalSeconds) || totalSeconds <= 0 || !Number.isFinite(gapSeconds) || gapSeconds < 0 || !Number.isInteger(groupChars) || groupChars < 0) throw new Error('seconds 必須 >0、gap 必須 >=0、group-chars 必須為非負整數')
const root = path.join('music', 'taiwan-tongues')
const clipsDir = path.join(root, 'clips')
const ffmpeg = path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg')

// 固定種子 LCG：抽樣可重現
let seed = 20_261_012
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}

const decodeMono48k = (audioPath) => {
  const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', audioPath, '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 256 * 1024 * 1024 })
  if (decoded.status !== 0) throw new Error(`ffmpeg 解碼失敗: ${audioPath}`)
  const bytes = Buffer.from(decoded.stdout)
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

const main = () => {
  // 讀每筆的標註文字（以 json 为准——tar 內附帶；tsv 是備援）
  const entries = readdirSync(clipsDir).filter((file) => file.endsWith('.json')).sort().map((file) => {
    const meta = JSON.parse(readFileSync(path.join(clipsDir, file), 'utf8'))
    const id = file.replace('.json', '')
    return { id, text: meta.sentence.replace(/\s+/g, ' ').trim() }
  }).filter((entry) => entry.text)
  // 固定種子洗牌
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[entries[index], entries[swap]] = [entries[swap], entries[index]]
  }

  const samples = []
  const sentences = []
  const clipRows = []
  let cursor = 0
  let group = null // 進行中的長句：多個 clip 累積到 groupChars 字
  const closeGroup = () => {
    if (!group) return
    sentences.push({ startMs: group.startMs, endMs: group.endMs, text: group.text.trim() })
    group = null
  }
  for (const entry of entries) {
    if (cursor >= totalSeconds * 48_000) break
    const clip = decodeMono48k(path.join(clipsDir, `${entry.id}.mp3`))
    if (clip.length < 48_000 || clip.length > 48_000 * 12) continue // 過短/過長的 clip 不要
    if (!group) group = { startMs: Math.round(cursor / 48), endMs: 0, text: '' }
    samples.push(clip)
    group.text += `${entry.text} `
    cursor += clip.length
    group.endMs = Math.round(cursor / 48)
    clipRows.push({ text: entry.text, clip: entry.id })
    if (group.text.trim().length >= groupChars) {
      closeGroup()
      if (cursor < totalSeconds * 48_000) {
        const gap = new Float32Array(Math.round(48_000 * gapSeconds))
        samples.push(gap)
        cursor += gap.length
      }
    }
  }
  closeGroup()

  // 寫 WAV (s16 mono 48k)：評測端 ffmpeg 再轉 48k/16k
  const wav = Buffer.alloc(44 + cursor * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + cursor * 2, 4); wav.write('WAVE', 8)
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(48_000, 24); wav.writeUInt32LE(48_000 * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(cursor * 2, 40)
  let offset = 44
  for (const block of samples) {
    for (const value of block) {
      wav.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(value * 32_767))), offset)
      offset += 2
    }
  }

  const base = arg('out-base', path.join(root, `fixture-${totalSeconds}s${groupChars ? `-g${groupChars}` : ''}`))
  writeFileSync(`${base}.wav`, wav)
  const tsv = ['start\tend\tspeaker\ttext',
    ...sentences.map((line) => `${(line.startMs / 1_000).toFixed(3)}\t${(line.endMs / 1_000).toFixed(3)}\t-\t${line.text}`)]
  writeFileSync(`${base}.tsv`, tsv.join('\n') + '\n')
  // 逐 clip 的標註（純 ASR 直測診斷用，獨立檔案避免污染評測 TSV 欄位）
  writeFileSync(`${base}.clips.tsv`, ['text\tclip',
    ...clipRows.map((row) => `${row.text}\t${row.clip}`)].join('\n') + '\n')
  writeFileSync(`${base}.manifest.json`, JSON.stringify({
    dataset: 'adi-gov-tw/Taiwan-Tongues-ASR-CE-dataset-zhtw', split: 'test',
    seed: 20_261_012, sampleRate: 48_000, requestedSeconds: totalSeconds,
    actualSeconds: cursor / 48_000, gapSeconds, groupChars,
    audioSha256: createHash('sha256').update(wav).digest('hex'),
    tsvSha256: createHash('sha256').update(tsv.join('\n') + '\n').digest('hex'),
    clips: clipRows
  }, null, 2) + '\n')
  const chars = sentences.reduce((sum, line) => sum + line.text.replace(/\s+/g, '').length, 0)
  console.log(`${base}.wav (${Math.round(cursor / 48_000)}s, 48kHz mono) + .tsv：${sentences.length} 句 / ${chars} 字 / ${clipRows.length} clips / group-chars=${groupChars}`)
}

main()
