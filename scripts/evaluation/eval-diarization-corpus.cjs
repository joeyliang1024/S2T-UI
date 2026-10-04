// Threshold sweep over a labelled corpus (VoxConverse dev and friends).
//
// `eval-diarization-timeline.cjs` scores one recording; this driver runs the
// same scoring across many recordings × several clustering thresholds and
// aggregates the two failure modes that matter for the adaptive rule in
// `server/sherpa-diarization.cjs`:
//
//   - over-clustering  (predicted > truth)  → too many SPEAKER_xx labels
//   - under-clustering (predicted < truth)  → two different people merged
//
// The second one is the risk of raising the threshold, so it is reported per
// file, not just as an average.
//
// Each run spawns a fresh process because the threshold is read from the
// environment at call time and the sherpa model is cached per process.
//
// Usage:
//   node scripts/evaluation/eval-diarization-corpus.cjs --tsv-dir <dir> --audio-dir <dir> \
//     --ids a,b,c [--thresholds 0.5,0.7,0.8] [--json out.json]
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback
}
const tsvDir = option('tsv-dir', '')
const audioDir = option('audio-dir', '')
const idsArg = option('ids', '')
if (!tsvDir || !audioDir || !idsArg) {
  console.error('用法：node scripts/evaluation/eval-diarization-corpus.cjs --tsv-dir <dir> --audio-dir <dir> --ids <id,id,...> [--thresholds 0.5,0.7,0.8]')
  process.exit(1)
}
const ids = idsArg === 'ALL'
  ? readdirSync(resolve(tsvDir)).filter((name) => name.endsWith('.tsv')).map((name) => name.replace(/\.tsv$/, ''))
  : idsArg.split(',').map((id) => id.trim()).filter(Boolean)
const thresholds = option('thresholds', '0.5,0.7,0.8').split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
const jsonPath = option('json', '')

const evaluator = resolve(__dirname, 'eval-diarization-timeline.cjs')
// Fresh process per run, so per-recording reports land in a private scratch dir.
const scratch = join(tmpdir(), `s2t-corpus-${process.pid}`)
mkdirSync(scratch, { recursive: true })

const round = (value, digits = 3) => Number(Number(value).toFixed(digits))

/** Ground-truth speaker count for one TSV (ignores `和聲` harmony rows). */
const truthSpeakers = (tsvPath) => {
  const lines = readFileSync(tsvPath, 'utf8').split('\n').slice(1).filter(Boolean)
  const speakers = new Set()
  let seconds = 0
  let count = 0
  for (const line of lines) {
    const [start, end, speaker] = line.split('\t')
    if (!speaker || speaker.includes('和聲')) continue
    const from = Number(start); const to = Number(end)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    speakers.add(speaker); seconds += to - from; count += 1
  }
  return { speakers: speakers.size, seconds: round(seconds), lines: count }
}

const results = []
const started = Date.now()
for (const threshold of thresholds) {
  for (const id of ids) {
    const tsvPath = join(resolve(tsvDir), `${id}.tsv`)
    const wavPath = join(resolve(audioDir), `${id}.wav`)
    if (!existsSync(tsvPath) || !existsSync(wavPath)) {
      console.log(`跳過 ${id} @${threshold}（缺 ${!existsSync(tsvPath) ? 'TSV' : 'WAV'}）`)
      continue
    }
    const reportPath = join(scratch, `${id}-${threshold}.json`)
    const run = spawnSync(process.execPath, [
      evaluator, '--tsv', tsvPath, '--audio', wavPath, '--equivalence', '0', '--json', reportPath
    ], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, S2T_SHERPA_CLUSTERING_THRESHOLD: String(threshold) }
    })
    if (!existsSync(reportPath)) {
      console.log(`失敗 ${id} @${threshold}: ${(run.stderr || run.stdout || '').trim().split('\n').slice(-1)[0]}`)
      results.push({ id, threshold, failed: true })
      continue
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const truth = truthSpeakers(tsvPath)
    const row = {
      id,
      threshold,
      truthSpeakers: truth.speakers,
      predictedSpeakers: report.predictedSpeakers.length,
      lines: report.lines,
      der: report.der,
      correctRatio: report.correctRatio,
      truthSeconds: truth.seconds,
      turns: report.predictedTurns
    }
    row.verdict = row.predictedSpeakers > row.truthSpeakers ? 'split'
      : row.predictedSpeakers < row.truthSpeakers ? 'merged' : 'exact'
    // Merge damage, not just merge count: a truth speaker that received no
    // predicted label is one whose speech has been absorbed into somebody else.
    // Its seconds come from the confusion matrix rows.
    const mapped = new Set(Object.keys(report.labelMapping))
    const unmapped = Object.keys(report.confusionSeconds).filter((speaker) => !mapped.has(speaker))
    row.unmappedTruthSpeakers = unmapped.length
    row.unmappedSeconds = round(unmapped.reduce((sum, speaker) =>
      sum + Object.values(report.confusionSeconds[speaker]).reduce((inner, value) => inner + value, 0), 0))
    row.unmappedRatio = truth.seconds ? round(row.unmappedSeconds / truth.seconds) : null
    results.push(row)
    console.log(
      `${id} @${threshold}  語者 ${row.truthSpeakers}→${row.predictedSpeakers} (${row.verdict})  ` +
      `句級 ${report.lines.correct}/${report.lines.scored}` +
      (report.lines.accuracy === null ? '' : ` = ${(report.lines.accuracy * 100).toFixed(1)}%`) +
      `  DER ${(report.der * 100).toFixed(1)}%  段=${report.predictedTurns}` +
      (row.unmappedTruthSpeakers ? `  被合併掉=${row.unmappedTruthSpeakers} 位語者/${(row.unmappedRatio * 100).toFixed(1)}% 人聲` : '')
    )
  }
}
const elapsed = (Date.now() - started) / 60000

/** Macro (per-file mean) and micro (pooled) scores for one threshold. */
const aggregate = (threshold) => {
  const rows = results.filter((row) => row.threshold === threshold && !row.failed)
  if (!rows.length) return null
  const scored = rows.reduce((sum, row) => sum + row.lines.scored, 0)
  const correct = rows.reduce((sum, row) => sum + row.lines.correct, 0)
  const regularSeconds = rows.reduce((sum, row) => sum + row.truthSeconds, 0)
  const confusionAndMiss = rows.reduce((sum, row) => sum + row.der * row.truthSeconds, 0)
  const macro = rows.filter((row) => row.lines.accuracy !== null)
  const unmappedSeconds = rows.reduce((sum, row) => sum + (row.unmappedSeconds || 0), 0)
  return {
    files: rows.length,
    microLineAccuracy: scored ? round(correct / scored) : null,
    macroLineAccuracy: macro.length ? round(macro.reduce((sum, row) => sum + row.lines.accuracy, 0) / macro.length) : null,
    linesScored: scored,
    linesCorrect: correct,
    der: regularSeconds ? round(confusionAndMiss / regularSeconds) : null,
    meanTruthSpeakers: round(rows.reduce((sum, row) => sum + row.truthSpeakers, 0) / rows.length, 2),
    meanPredictedSpeakers: round(rows.reduce((sum, row) => sum + row.predictedSpeakers, 0) / rows.length, 2),
    split: rows.filter((row) => row.verdict === 'split').length,
    merged: rows.filter((row) => row.verdict === 'merged').length,
    exact: rows.filter((row) => row.verdict === 'exact').length,
    // Ground-truth speech whose speaker received no label at all — the cost of
    // merging, as opposed to the cost of over-splitting.
    mergedTruthSpeakers: rows.reduce((sum, row) => sum + (row.unmappedTruthSpeakers || 0), 0),
    mergedSpeechRatio: regularSeconds ? round(unmappedSeconds / regularSeconds) : null,
    mergedFiles: rows.filter((row) => row.verdict === 'merged').map((row) => `${row.id}(${row.truthSpeakers}→${row.predictedSpeakers})`),
    worstFiles: [...rows].sort((a, b) => (a.lines.accuracy ?? 0) - (b.lines.accuracy ?? 0)).slice(0, 5)
      .map((row) => ({ id: row.id, truth: row.truthSpeakers, predicted: row.predictedSpeakers, accuracy: row.lines.accuracy, der: row.der }))
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  tsvDir: resolve(tsvDir),
  audioDir: resolve(audioDir),
  ids,
  thresholds,
  minutes: round(elapsed, 1),
  thresholds: thresholds.map((threshold) => ({ threshold, ...aggregate(threshold) })),
  results
}
console.log('\n=== 匯總 ===')
for (const entry of summary.thresholds) {
  if (!entry) continue
  console.log(
    `門檻 ${entry.threshold}  檔案=${entry.files}  ` +
    `句級(微) ${entry.microLineAccuracy === null ? '-' : (entry.microLineAccuracy * 100).toFixed(1)}%  ` +
    `句級(宏) ${entry.macroLineAccuracy === null ? '-' : (entry.macroLineAccuracy * 100).toFixed(1)}%  ` +
    `DER ${entry.der === null ? '-' : (entry.der * 100).toFixed(1)}%  ` +
    `語者 ${entry.meanTruthSpeakers}→${entry.meanPredictedSpeakers}  ` +
    `過切=${entry.split} 合併=${entry.merged} 準確=${entry.exact}  ` +
    `被合併語者=${entry.mergedTruthSpeakers} 位` +
    (entry.mergedSpeechRatio === null ? '' : ` (${(entry.mergedSpeechRatio * 100).toFixed(1)}% 人聲失去標籤)`)
  )
  if (entry.mergedFiles.length) console.log(`  合併（不同人被黏成同一標籤）：${entry.mergedFiles.join(', ')}`)
}
console.log(`總耗時 ${summary.minutes} 分鐘`)

rmSync(scratch, { recursive: true, force: true })
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify(summary, null, 2)); console.log(`已寫入 ${resolve(jsonPath)}`) }
