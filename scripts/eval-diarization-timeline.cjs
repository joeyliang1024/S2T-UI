// Diarization quality against a labelled timeline (P4-3 companion).
//
// Answers two questions with one run of real audio:
//
//   1. 語者辨識是否和 sherpa 一樣 — the worker-pool path the gateway ships is
//      compared byte-for-byte against `sherpa-diarization.cjs` called directly
//      on the main thread. Any divergence in preprocessing, resampling or
//      label formatting shows up here.
//   2. 標註效果 — the predicted turns are scored against the TSV ground truth.
//      Anonymous SPEAKER_xx labels are mapped to the labelled speakers by an
//      optimal assignment over the confusion matrix, so the score measures
//      segmentation + clustering, not label naming.
//
// Reported: miss / confusion / false-alarm time, DER, line-level accuracy,
// and the per-speaker confusion matrix. Harmony lines carry both voices and
// are reported for coverage only.
//
// Usage:
//   node scripts/eval-diarization-timeline.cjs --tsv <file.tsv> --audio <file.wav> \
//     [--json out.json] [--threshold <coverage 0..1>]
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { diarizeWav, clusteringThresholdFor, readWavSamples } = require('../server/sherpa-diarization.cjs')
const { sherpaWorkerPool } = require('../server/sherpa-worker-pool.cjs')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback
}
const tsvPath = option('tsv', '')
const audioPath = option('audio', '')
if (!args.includes('--mapping-selftest') && (!tsvPath || !audioPath)) {
  console.error('用法：node scripts/eval-diarization-timeline.cjs --tsv <時間軸.tsv> --audio <來源.wav>')
  process.exit(1)
}
const jsonPath = option('json', '')
const overlapThreshold = Number(option('coverage', '0.35'))
// Sweeps re-score the same recording many times; skip the second (identical)
// diarization when only the quality number is wanted.
const runEquivalence = option('equivalence', '1') !== '0'

const round = (value, digits = 3) => Number(Number(value).toFixed(digits))

/** `start end speaker text` in seconds, harmony kept apart. */
const readTimeline = (path) => {
  const lines = readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  const rows = []
  for (const line of lines.slice(1)) {
    const [start, end, speaker, ...rest] = line.split('\t')
    const from = Number(start); const to = Number(end)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !speaker) continue
    rows.push({ start: from, end: to, speaker, text: rest.join('\t') })
  }
  return rows
}

/** Total seconds of `ranges` covered by `turns` (both in seconds). */
const covered = (ranges, turns) => ranges.reduce((sum, range) => {
  return sum + turns.reduce((inner, turn) => inner + Math.max(0, Math.min(range.end, turn.end) - Math.max(range.start, turn.start)), 0)
}, 0)

/** Every predicted label × every ground-truth speaker, in seconds. */
const confusion = (truth, turns) => {
  const matrix = new Map()
  for (const row of truth) {
    const bucket = matrix.get(row.speaker) || new Map()
    matrix.set(row.speaker, bucket)
    for (const turn of turns) {
      const shared = Math.max(0, Math.min(row.end, turn.end) - Math.max(row.start, turn.start))
      if (shared > 0) bucket.set(turn.speaker, (bucket.get(turn.speaker) || 0) + shared)
    }
  }
  return matrix
}

/**
 * Hungarian (Kuhn–Munkres) minimum-cost assignment.
 *
 * `cost` is 1-indexed and square (`cost[0]` / `cost[i][0]` are padding); rows
 * and columns are matched one-to-one so the result is a perfect matching.
 * Returns `{ assignment, minCost }` where `assignment[i]` is the column taken
 * by row `i`, and `0` when the row is left unmatched (only possible on a
 * rectangular matrix).
 *
 * This replaces a brute-force walk over permutations: P(40, 20) ≈ 1e27, which
 * hangs the moment a real multi-speaker recording produces that many labels.
 * O(n²m) is microseconds at these sizes.
 */
const hungarian = (cost) => {
  const n = cost.length - 1
  const m = cost[0].length - 1
  const u = new Float64Array(n + 1)
  const v = new Float64Array(m + 1)
  const pair = new Int32Array(m + 1)
  const way = new Int32Array(m + 1)
  for (let i = 1; i <= n; i += 1) {
    pair[0] = i
    let j0 = 0
    const minv = new Float64Array(m + 1).fill(Number.POSITIVE_INFINITY)
    const used = new Uint8Array(m + 1)
    do {
      used[j0] = 1
      const i0 = pair[j0]
      let delta = Number.POSITIVE_INFINITY
      let j1 = 0
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue
        const current = cost[i0][j] - u[i0] - v[j]
        if (current < minv[j]) { minv[j] = current; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) { u[pair[j]] += delta; v[j] -= delta } else { minv[j] -= delta }
      }
      j0 = j1
    } while (pair[j0] !== 0)
    do {
      const j1 = way[j0]
      pair[j0] = pair[j1]
      j0 = j1
    } while (j0 !== 0)
  }
  const assignment = new Int32Array(n + 1)
  let total = 0
  for (let j = 1; j <= m; j += 1) {
    if (pair[j] > 0) { assignment[pair[j]] = j; total += cost[pair[j]][j] }
  }
  return { assignment, minCost: total }
}

/**
 * Optimal truth→prediction assignment over the confusion matrix (maximise
 * overlapping seconds). Hungarian instead of brute force — VoxConverse dev has
 * up to 20 ground-truth speakers per clip, where permutations are intractable.
 */
const optimalMapping = (matrix) => {
  const truths = [...matrix.keys()]
  const predictions = [...new Set(truths.flatMap((row) => [...matrix.get(row).keys()]))]
  if (!truths.length || !predictions.length) return { mapping: new Map(), score: 0 }
  // Square padding: extra rows/columns cost 0, so they stand for "unmatched".
  const size = Math.max(truths.length, predictions.length)
  const cost = Array.from({ length: size + 1 }, () => new Float64Array(size + 1))
  for (let i = 1; i <= truths.length; i += 1) {
    const row = matrix.get(truths[i - 1])
    for (let j = 1; j <= predictions.length; j += 1) cost[i][j] = -(row.get(predictions[j - 1]) || 0)
  }
  const { assignment, minCost } = hungarian(cost)
  const mapping = new Map()
  for (let i = 1; i <= truths.length; i += 1) {
    const j = assignment[i]
    if (j >= 1 && j <= predictions.length) mapping.set(truths[i - 1], predictions[j - 1])
  }
  return { mapping, score: -minCost }
}

/**
 * `--mapping-selftest` checks `optimalMapping` against brute force on random
 * matrices (up to 6×6, where the old walk is still feasible).
 */
const selfTestMapping = (rounds = 400) => {
  const bruteForce = (m) => {
    const truths = [...m.keys()]
    const preds = [...new Set(truths.flatMap((t) => [...m.get(t).keys()]))]
    if (!truths.length || !preds.length) return 0
    let best = 0
    const walk = (i, used, score) => {
      if (i === truths.length) { if (score > best) best = score; return }
      const row = m.get(truths[i])
      for (const label of preds) {
        if (used.has(label)) continue
        used.add(label)
        walk(i + 1, used, score + (row.get(label) || 0))
        used.delete(label)
      }
      if (preds.length <= truths.length) walk(i + 1, used, score)
    }
    walk(0, new Set(), 0)
    return best
  }
  let seed = 20261001
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let round = 0; round < rounds; round += 1) {
    const n = 1 + Math.floor(rand() * 6)
    const p = 1 + Math.floor(rand() * 6)
    const labels = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, p)
    const matrix = new Map()
    for (let i = 0; i < n; i += 1) {
      const row = new Map()
      for (const label of labels) if (rand() < 0.6) row.set(label, Math.round(rand() * 1000))
      if (row.size) matrix.set(`t${i}`, row)
    }
    const { mapping, score } = optimalMapping(matrix)
    const expected = bruteForce(matrix)
    if (score !== expected) throw new Error(`mapping mismatch: got ${score}, expected ${expected}`)
    const seen = new Set([...mapping.values()])
    if (seen.size !== mapping.size) throw new Error('mapping is not injective')
  }
  console.log(`mapping self-test: ${rounds} 隨機矩陣 皆與暴力法一致`)
}

if (args.includes('--mapping-selftest')) {
  selfTestMapping(Number(option('rounds', '400')))
  process.exit(0)
}

const main = async () => {
  const audio = readFileSync(resolve(audioPath))
  const truth = readTimeline(resolve(tsvPath))
  const regular = truth.filter((row) => !row.speaker.includes('和聲'))
  const harmony = truth.filter((row) => row.speaker.includes('和聲'))

  // 1. worker-pool path vs. raw sherpa on the identical bytes.
  let rawTurns = []
  let rawMs = 0
  if (runEquivalence) {
    const rawStart = Date.now()
    rawTurns = diarizeWav(audio)
    rawMs = Date.now() - rawStart
  }
  const poolStart = Date.now()
  const poolTurns = await sherpaWorkerPool.execute('diarizeWav', { audio, segments: [] }, { retainAudio: true })
  const poolMs = Date.now() - poolStart
  await sherpaWorkerPool.close()

  const serialise = (turns) => turns.map((turn) => `${turn.start.toFixed(6)}|${turn.end.toFixed(6)}|${turn.speaker}`).join(';')
  const identicalToSherpa = runEquivalence ? serialise(rawTurns) === serialise(poolTurns) : null

  // 2. score against the labels.
  const matrix = confusion(regular, poolTurns)
  const { mapping } = optimalMapping(matrix)
  // `mapping` is truth→prediction; line scoring needs the inverse lookup.
  const speakerOf = new Map([...mapping].map(([truth, predicted]) => [predicted, truth]))
  const totalRegular = regular.reduce((sum, row) => sum + (row.end - row.start), 0)
  const missSeconds = totalRegular - covered(regular, poolTurns)
  let correctSeconds = 0
  let confusionSeconds = 0
  for (const row of regular) {
    for (const turn of poolTurns) {
      const shared = Math.max(0, Math.min(row.end, turn.end) - Math.max(row.start, turn.start))
      if (!shared) continue
      if (mapping.get(row.speaker) === turn.speaker) correctSeconds += shared
      else confusionSeconds += shared
    }
  }
  const predictedSeconds = poolTurns.reduce((sum, turn) => sum + (turn.end - turn.start), 0)
  const falseAlarmSeconds = Math.max(0, predictedSeconds - covered(regular, poolTurns))

  const perLine = regular.map((row) => {
    const overlap = new Map()
    for (const turn of poolTurns) {
      const shared = Math.max(0, Math.min(row.end, turn.end) - Math.max(row.start, turn.start))
      if (shared > 0) overlap.set(turn.speaker, (overlap.get(turn.speaker) || 0) + shared)
    }
    const best = [...overlap.entries()].sort((a, b) => b[1] - a[1])[0]
    const span = row.end - row.start
    const predicted = best && best[1] / span >= overlapThreshold ? best[0] : null
    return { ...row, predicted, mapped: predicted ? (speakerOf.get(predicted) ?? null) : null, agreement: best ? best[1] / span : 0 }
  })
  const scoredLines = perLine.filter((row) => row.predicted)
  const correctLines = scoredLines.filter((row) => row.mapped === row.speaker)

  const harmonyCoverage = harmony.length ? covered(harmony, poolTurns) / harmony.reduce((sum, row) => sum + (row.end - row.start), 0) : null

  const parsedWave = readWavSamples(audio)
  const durationSec = parsedWave.samples.length / (parsedWave.sampleRate || 16_000)

  const report = {
    audio: resolve(audioPath),
    tsv: resolve(tsvPath),
    clusteringThreshold: clusteringThresholdFor(durationSec),
    predictedTurns: poolTurns.length,
    predictedSpeakers: [...new Set(poolTurns.map((turn) => turn.speaker))].sort(),
    truthLines: { regular: regular.length, harmony: harmony.length },
    equivalence: {
      checked: runEquivalence,
      identicalToSherpa,
      rawMs,
      poolMs,
      rawSegments: rawTurns.length,
      poolSegments: poolTurns.length,
      rawFirst: rawTurns.slice(0, 3),
      poolFirst: poolTurns.slice(0, 3)
    },
    labelMapping: Object.fromEntries(mapping),
    confusionSeconds: Object.fromEntries([...matrix].map(([row, bucket]) => [row, Object.fromEntries([...bucket].map(([label, seconds]) => [label, round(seconds)]))])),
    time: {
      totalRegular: round(totalRegular),
      miss: round(missSeconds),
      correct: round(correctSeconds),
      confusion: round(confusionSeconds),
      falseAlarm: round(falseAlarmSeconds)
    },
    der: round((missSeconds + confusionSeconds) / totalRegular),
    correctRatio: round(correctSeconds / totalRegular),
    lines: {
      scored: scoredLines.length,
      correct: correctLines.length,
      accuracy: scoredLines.length ? round(correctLines.length / scoredLines.length) : null,
      unlabelled: regular.length - scoredLines.length
    },
    harmonyCoverage: harmonyCoverage === null ? null : round(harmonyCoverage),
    turns: poolTurns
  }
  report.mismatches = perLine.filter((row) => row.predicted && row.mapped !== row.speaker).map((row) => ({
    start: row.start, end: row.end, truth: row.speaker, predictedLabel: row.predicted, mapped: row.mapped ?? null, agreement: round(row.agreement)
  }))

  console.log(JSON.stringify(report, null, 2))
  console.log('\n=== 摘要 ===')
  console.log(`聚類門檻 threshold=${report.clusteringThreshold}，預測語者 ${report.predictedSpeakers.length} 位（標註實際 ${new Set(regular.map((row) => row.speaker)).size} 位）：${report.predictedSpeakers.join(', ')}`)
  console.log(`與 sherpa 一致: ${identicalToSherpa === null ? '（已跳過）' : identicalToSherpa ? '是（逐段完全相同）' : '否 ← 需要調查'}`)
  console.log(`DER: ${(report.der * 100).toFixed(1)}%  (miss ${(missSeconds / totalRegular * 100).toFixed(1)}% + confusion ${(confusionSeconds / totalRegular * 100).toFixed(1)}%)`)
  console.log(`句級正確率: ${report.lines.correct}/${report.lines.scored}` + (report.lines.accuracy === null ? '' : ` = ${(report.lines.accuracy * 100).toFixed(1)}%`))
  console.log(`標籤對應: ${JSON.stringify(report.labelMapping)}`)
  if (harmonyCoverage !== null) console.log(`和聲涵蓋率: ${(harmonyCoverage * 100).toFixed(1)}%（僅計涵蓋，不計對錯）`)
  if (jsonPath) { writeFileSync(jsonPath, JSON.stringify(report, null, 2)); console.log(`已寫入 ${jsonPath}`) }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
