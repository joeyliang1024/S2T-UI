#!/usr/bin/env node
// 事後比較：讀入多份 caption-latency-*.json，用與評測同一套指標
// （text-metrics.cjs）從原始欄位統一補算 CER／WER，加上延遲與碎片化，
// 印成一張對比表。用途：
//   - 舊報告（WER 尚未原生寫入）補算 WER，不必重跑 ASR
//   - 跨素材／跨批次的報告彙整成單表判讀
//
//   node scripts/evaluation/compare-reports.cjs experiment/evaluation-reports/caption-latency-*-300s.json
const { readFileSync } = require('node:fs')
const { corpusRates, sentenceRates } = require('./text-metrics.cjs')

const files = process.argv.slice(2)
if (!files.length) throw new Error('用法: node scripts/evaluation/compare-reports.cjs <report.json...>')

const rows = files.map((file) => {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const details = report.detail || []
  // 逐句（加權彙總）：以 detail 的 hyp（重疊 chunk 事件拼接）重算
  let cerSum = 0
  let werSum = 0
  let refCharsTotal = 0
  let refWordsTotal = 0
  for (const item of details) {
    const rates = sentenceRates(item.text || '', item.hyp || '')
    if (rates.cer !== null) cerSum += rates.cer * rates.refChars
    if (rates.wer !== null) werSum += rates.wer * rates.refWords
    refCharsTotal += rates.refChars
    refWordsTotal += rates.refWords
  }
  // 語料：標準答案＝detail 參考句拼接；假設＝有時間重疊的合併字幕拼接
  const overlapsSentence = (caption) => details.some((item) => caption.startMs < item.endMs && caption.endMs > item.startMs)
  const corpus = corpusRates(
    details.map((item) => item.text || '').join(''),
    (report.captions || []).filter(overlapsSentence).map((caption) => caption.text || '').join('')
  )
  const accuracy = report.accuracy || {}
  return {
    preset: report.preset,
    latencyP50: report.latencyMs?.p50,
    latencyP95: report.latencyMs?.p95,
    within2500: report.latencyMs?.within2500AllPct,
    sentenceCer: refCharsTotal ? Math.round(cerSum / refCharsTotal * 10_000) / 100 : accuracy.sentenceCerPct,
    corpusCer: corpus.cer === null ? accuracy.corpusCerPct : Math.round(corpus.cer * 10_000) / 100,
    sentenceWer: refWordsTotal ? Math.round(werSum / refWordsTotal * 10_000) / 100 : accuracy.sentenceWerPct ?? null,
    corpusWer: corpus.wer === null ? accuracy.corpusWerPct ?? null : Math.round(corpus.wer * 10_000) / 100,
    captions: report.fragmentation?.displayedCaptions,
    veto: [report.chunks?.gateVetoed, report.chunks?.hallucVetoed].some((value) => value)
      ? `閘門${report.chunks.gateVetoed || 0}/幻覺${report.chunks.hallucVetoed || 0}`
      : '-',
    audio: (report.audio || '').slice(0, 12)
  }
})

const header = ['preset', '素材', '延遲p50', '延遲p95', '≤2500ms', '逐句CER', '語料CER', '逐句WER', '語料WER', '字幕行', '否決']
const table = rows.map((row) => [row.preset, row.audio, `${row.latencyP50}ms`, `${row.latencyP95}ms`, `${row.within2500}%`, `${row.sentenceCer ?? '-'}%`, `${row.corpusCer ?? '-'}%`, `${row.sentenceWer ?? '-'}%`, `${row.corpusWer ?? '-'}%`, row.captions, row.veto])
const widths = header.map((cell, index) => Math.max(cell.length, ...table.map((r) => String(r[index]).length)))
console.log(header.map((cell, index) => cell.padEnd(widths[index])).join('  '))
table.forEach((row) => console.log(row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')))
