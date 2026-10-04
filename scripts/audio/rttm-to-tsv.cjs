// RTTM → sentence-level TSV.
//
// Diarization ground truth ships as RTTM:
//   SPEAKER <file> 1 <start> <dur> <NA> <NA> <speaker> <NA> <NA>
// while the evaluation scripts in this directory read the sentence timeline
// used elsewhere in the project:
//   start <TAB> end <TAB> speaker <TAB> text
//
// `text` is left empty because RTTM carries no transcription; the eval scripts
// only score time overlap, so an empty column is enough.
//
// Usage:
//   node scripts/audio/rttm-to-tsv.cjs <input.rttm>                # → stdout
//   node scripts/audio/rttm-to-tsv.cjs <input.rttm> --out out.tsv
//   node scripts/audio/rttm-to-tsv.cjs <rttm-dir> --out <tsv-dir>
const { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { basename, dirname, extname, join, resolve } = require('node:path')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback
}
const input = args.find((value) => !value.startsWith('--'))
const outputPath = option('out', '')
if (!input) {
  console.error('用法：node scripts/audio/rttm-to-tsv.cjs <input.rttm | rttm-dir> [--out <file.tsv | dir>]')
  process.exit(1)
}

/** Parse one RTTM into `{ start, end, speaker }` rows, sorted by time. */
const parseRttm = (text) => text.split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('SPEAKER '))
  .map((line) => line.split(/\s+/))
  .filter((fields) => fields.length >= 8)
  .map((fields) => {
    const start = Number(fields[3])
    const duration = Number(fields[4])
    return Number.isFinite(start) && Number.isFinite(duration) && duration > 0 && fields[7]
      ? { start, end: start + duration, speaker: fields[7] }
      : null
  })
  .filter(Boolean)
  .sort((a, b) => a.start - b.start)

const toTsv = (rows) => [
  'start\tend\tspeaker\ttext',
  ...rows.map((row) => `${row.start.toFixed(3)}\t${row.end.toFixed(3)}\t${row.speaker}\t`)
].join('\n') + '\n'

const convert = (source, destination, write) => {
  const rows = parseRttm(readFileSync(source, 'utf8'))
  if (!rows.length) throw new Error(`${source} 沒有可用的 SPEAKER 段`)
  const tsv = toTsv(rows)
  if (write) {
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, tsv)
    const speakers = new Set(rows.map((row) => row.speaker)).size
    const seconds = rows.reduce((sum, row) => sum + (row.end - row.start), 0)
    console.log(`${basename(destination)}  段=${rows.length}  語者=${speakers}  人聲=${seconds.toFixed(1)}s  → ${destination}`)
  }
  return tsv
}

const inputPath = resolve(input)
if (statSync(inputPath).isDirectory()) {
  const files = readdirSync(inputPath).filter((name) => extname(name).toLowerCase() === '.rttm').sort()
  if (!files.length) throw new Error(`${inputPath} 底下沒有 .rttm`)
  if (!outputPath) throw new Error('目錄模式必須指定 --out <輸出目錄>')
  const outputDir = resolve(outputPath)
  mkdirSync(outputDir, { recursive: true })
  for (const name of files) convert(join(inputPath, name), join(outputDir, `${basename(name, '.rttm')}.tsv`), true)
  console.log(`\n完成：${files.length} 個 RTTM → ${outputDir}`)
} else {
  const tsv = convert(inputPath, outputPath, Boolean(outputPath))
  if (!outputPath) process.stdout.write(tsv)
}
