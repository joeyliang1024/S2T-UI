// Labeled voiceprint evaluation (P0-3 / P4-3).
//
// Input: a TSV timeline (`start  end  speaker  text`, seconds) plus the source
// recording. Every non-harmony line becomes one clip; the first N lines of
// each singer are used for enrollment and are excluded from the test set, so
// no test clip can ever be compared against itself.
//
// Reports the score distributions, the Equal Error Rate point, and the
// 正確 / 錯配 / 拒識 rates of the production rule (threshold + margin) together
// with a threshold sweep. Harmony lines contain both voices, so they are
// measured separately instead of being counted as right or wrong.
//
// Usage:
//   node scripts/eval-voiceprint-timeline.cjs --tsv <file.tsv> --audio <file.wav> \
//     [--enroll-lines 4] [--threshold 0.65] [--margin 0.05] [--json out.json]
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { extractSpeakerEmbedding } = require('../server/sherpa-diarization.cjs')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback
}
const tsvPath = option('tsv', '')
const audioPath = option('audio', '')
if (!tsvPath || !audioPath) {
  console.error('用法：node scripts/eval-voiceprint-timeline.cjs --tsv <時間軸.tsv> --audio <來源.wav>')
  process.exit(1)
}
const enrollLines = Number(option('enroll-lines', 4)) || 4
const threshold = Number(option('threshold', process.env.S2T_VOICEPRINT_THRESHOLD || 0.65))
const margin = Number(option('margin', process.env.S2T_VOICEPRINT_MARGIN || 0.05))
const jsonPath = option('json', '')

const round = (value, digits = 3) => Number(Number(value).toFixed(digits))
const quantile = (sorted, q) => sorted[Math.floor((sorted.length - 1) * q)]
const distribution = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return { n: sorted.length, min: round(sorted[0]), p05: round(quantile(sorted, 0.05)), median: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), max: round(sorted[sorted.length - 1]) }
}
const show = (label, stats) => stats
  ? `${label} n=${String(stats.n).padStart(3)}  min=${stats.min.toFixed(3)}  p05=${stats.p05.toFixed(3)}  median=${stats.median.toFixed(3)}  p95=${stats.p95.toFixed(3)}  max=${stats.max.toFixed(3)}`
  : `${label} (no pairs)`

const cosine = (left, right) => {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

/** Slice [start, end) out of the source WAV and rebuild a valid WAV buffer. */
const makeClip = (wav, header, startSec, endSec) => {
  const from = header.dataOffset + Math.round(startSec * header.bytesPerSec)
  const to = header.dataOffset + Math.round(endSec * header.bytesPerSec)
  const data = wav.subarray(Math.max(header.dataOffset, from), Math.min(header.dataOffset + header.dataSize, to))
  const output = Buffer.alloc(44 + data.length)
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8)
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(header.channels, 22)
  output.writeUInt32LE(header.sampleRate, 24); output.writeUInt32LE(header.bytesPerSec, 28)
  output.writeUInt16LE(header.channels * header.bits / 8, 32); output.writeUInt16LE(header.bits, 34)
  output.write('data', 36); output.writeUInt32LE(data.length, 40)
  data.copy(output, 44)
  return output
}

const readHeader = (wav) => {
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') throw new Error('音檔不是 RIFF/WAVE')
  let offset = 12
  let header = null
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      header = { channels: wav.readUInt16LE(offset + 10), sampleRate: wav.readUInt32LE(offset + 12), bits: wav.readUInt16LE(offset + 22) || 16 }
    } else if (id === 'data' && header) {
      header.dataOffset = offset + 8
      header.dataSize = size
      header.bytesPerSec = header.sampleRate * header.channels * (header.bits / 8)
      return header
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('找不到 WAV data chunk')
}

const parseTsv = (text) => text
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(1)
  .map((line, index) => {
    const [start, end, speaker, ...rest] = line.split('\t')
    const raw = String(speaker || '').trim()
    if (!raw) return null
    const harmony = /\(和聲\)|\(harmony\)/i.test(raw)
    const name = raw.replace(/\(.*?\)/g, '').trim()
    const parsed = { index, start: Number(start), end: Number(end), name, harmony, text: rest.join(' ') }
    if (!Number.isFinite(parsed.start) || !Number.isFinite(parsed.end) || parsed.end <= parsed.start) return null
    return parsed
  })
  .filter(Boolean)

;(async () => {
  const wav = readFileSync(resolve(audioPath))
  const header = readHeader(wav)
  const lines = parseTsv(readFileSync(resolve(tsvPath), 'utf8'))
  const singers = [...new Set(lines.filter((line) => !line.harmony).map((line) => line.name))]
  if (singers.length < 2) throw new Error(`至少需要兩位歌手，實際只有：${singers.join('、')}`)

  // Enrollment: the first N solo lines of each singer, concatenated the way a
  // single registration sample would be. Everything else is test material.
  const enroll = new Map()
  for (const singer of singers) {
    const picks = lines.filter((line) => !line.harmony && line.name === singer).slice(0, enrollLines)
    if (picks.length < 1) throw new Error(`${singer} 沒有可註冊的 solo 句`)
    const clips = picks.map((line) => makeClip(wav, header, line.start, line.end))
    enroll.set(singer, { embedding: extractSpeakerEmbedding(Buffer.concat(clips)), lines: picks })
  }
  const enrollmentIds = new Set([...enroll.values()].flatMap((value) => value.lines.map((line) => line.index)))
  console.log(`enrolled: ${[...enroll.entries()].map(([name, value]) => `${name} (${value.lines.length} 句, ${value.lines.reduce((sum, line) => sum + (line.end - line.start), 0).toFixed(1)} s)`).join(' | ')}`)

  // Test set: every remaining solo line.
  const testLines = lines.filter((line) => !line.harmony && !enrollmentIds.has(line.index))
  const results = []
  for (const line of testLines) {
    const embedding = extractSpeakerEmbedding(makeClip(wav, header, line.start, line.end))
    const scores = [...enroll.entries()].map(([name, value]) => ({ NT: name, score: cosine(embedding, value.embedding) })).sort((left, right) => right.score - left.score)
    results.push({ line, embedding, scores, best: scores[0], second: scores[1] })
  }

  // Pairwise distributions over the test set only.
  const same = []
  const different = []
  for (let left = 0; left < results.length; left += 1) {
    for (let right = left + 1; right < results.length; right += 1) {
      const score = cosine(results[left].embedding, results[right].embedding)
      if (results[left].line.name === results[right].line.name) same.push(score)
      else different.push(score)
    }
  }

  // The rule under test: best score ≥ threshold, and its lead over the second
  // identity ≥ margin. Rejection is the safe outcome, a wrong NT is not.
  const decide = (item, thr = threshold, mg = margin) => {
    if (!item.best) return 'reject'
    if (item.best.score < thr) return 'reject'
    if (item.second && item.best.score - item.second.score < mg) return 'reject'
    return item.best.NT === item.line.name ? 'correct' : 'mismatch'
  }
  const tally = (thr, mg) => {
    const counts = { correct: 0, mismatch: 0, reject: 0, correctSec: 0, mismatchSec: 0, rejectSec: 0 }
    for (const item of results) {
      const decision = decide(item, thr, mg)
      counts[decision] += 1
      counts[`${decision}Sec`] += item.line.end - item.line.start
    }
    return counts
  }

  let eer = { threshold: NaN, far: NaN, frr: NaN, delta: Infinity }
  if (same.length && different.length) {
    for (const candidate of [...new Set([...same, ...different])].sort((left, right) => left - right)) {
      const far = different.filter((score) => score >= candidate).length / different.length
      const frr = same.filter((score) => score < candidate).length / same.length
      if (Math.abs(far - frr) < eer.delta) eer = { threshold: candidate, far, frr, delta: Math.abs(far - frr) }
    }
  }

  const total = results.length
  const totalSec = results.reduce((sum, item) => sum + (item.line.end - item.line.start), 0)
  const counts = tally(threshold, margin)
  const rate = (value) => round(value / total)

  console.log('')
  console.log(`test lines: ${total} 句 / ${totalSec.toFixed(1)} s（已排除註冊句與和聲句）`)
  console.log(show('same-singer   ', distribution(same)))
  console.log(show('diff-singer   ', distribution(different)))
  if (Number.isFinite(eer.threshold)) console.log(`EER point: threshold=${round(eer.threshold)} far=${round(eer.far)} frr=${round(eer.frr)}`)
  console.log('')
  console.log(`rule: threshold=${threshold} margin=${margin}`)
  console.log(`  正確 ${counts.correct}/${total} (${rate(counts.correct)})  錯配 ${counts.mismatch}/${total} (${rate(counts.mismatch)})  拒識 ${counts.reject}/${total} (${rate(counts.reject)})`)
  console.log(`  以語音長度計：正確 ${round(counts.correctSec / totalSec)}  錯配 ${round(counts.mismatchSec / totalSec)}  拒識 ${round(counts.rejectSec / totalSec)}`)

  const mismatches = results.filter((item) => decide(item) === 'mismatch').map((item) => ({ line: `${item.line.start.toFixed(1)}-${item.line.end.toFixed(1)}`, text: item.line.text.slice(0, 12), expected: item.line.name, got: item.best.NT, score: round(item.best.score), lead: round(item.best.score - (item.second?.score || 0)) }))
  if (mismatches.length) console.log(`  錯配明細：${JSON.stringify(mismatches)}`)

  console.log('')
  console.log('threshold sweep（識別規則，含 margin）：')
  console.log('  thr    正確    錯配    拒識   | pair-FAR pair-FRR')
  const sweep = []
  for (const candidate of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]) {
    const value = tally(candidate, margin)
    const far = different.length ? different.filter((score) => score >= candidate).length / different.length : 0
    const frr = same.length ? same.filter((score) => score < candidate).length / same.length : 0
    sweep.push({ threshold: candidate, ...value, pairFar: round(far), pairFrr: round(frr) })
    const marker = Math.abs(candidate - threshold) < 1e-9 ? ' <- 目前' : ''
    console.log(`  ${candidate.toFixed(2)}  ${rate(value.correct).toFixed(3)}  ${rate(value.mismatch).toFixed(3)}  ${rate(value.reject).toFixed(3)}   |   ${round(far).toFixed(3)}     ${round(frr).toFixed(3)}${marker}`)
  }

  // Harmony lines: both voices are present, so they are reported but never
  // counted as correct or wrong.
  const harmony = lines.filter((line) => line.harmony)
  const harmonyReport = []
  for (const line of harmony) {
    const embedding = extractSpeakerEmbedding(makeClip(wav, header, line.start, line.end))
    const scores = [...enroll.entries()].map(([name, value]) => ({ NT: name, score: cosine(embedding, value.embedding) })).sort((left, right) => right.score - left.score)
    harmonyReport.push({ start: round(line.start, 1), text: line.text.slice(0, 12), best: scores[0].NT, score: round(scores[0].score), lead: round(scores[0].score - scores[1].score) })
  }
  if (harmonyReport.length) {
    console.log('')
    console.log(`和聲句（兩種聲音同時存在，僅供觀察）：${JSON.stringify(harmonyReport)}`)
  }

  if (jsonPath) {
    writeFileSync(resolve(jsonPath), `${JSON.stringify({
      audio: audioPath,
      tsv: tsvPath,
      enrollLines,
      singers,
      threshold,
      margin,
      testLines: total,
      testSeconds: round(totalSec, 1),
      distributions: { same: distribution(same), different: distribution(different) },
      eer: Number.isFinite(eer.threshold) ? { threshold: round(eer.threshold), far: round(eer.far), frr: round(eer.frr) } : null,
      result: { correct: counts.correct, mismatch: counts.mismatch, reject: counts.reject, bySeconds: { correct: round(counts.correctSec / totalSec), mismatch: round(counts.mismatchSec / totalSec), reject: round(counts.rejectSec / totalSec) } },
      mismatches,
      sweep,
      harmony: harmonyReport
    }, null, 2)}\n`)
    console.log(`\nreport written to ${resolve(jsonPath)}`)
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
