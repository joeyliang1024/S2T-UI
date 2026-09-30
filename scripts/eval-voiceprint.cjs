// Measure voiceprint matching quality on labelled audio instead of guessing
// thresholds. Reads a JSONL manifest of {"wav": "...", "nt": "..."} lines,
// extracts one embedding per file, then reports:
//   - same/different speaker score distributions
//   - the Equal Error Rate threshold
//   - identification accuracy at a chosen threshold + margin
//
// Usage:
//   node scripts/eval-voiceprint.cjs --manifest voiceprints.jsonl \
//     [--threshold 0.65] [--margin 0.05] [--json report.json]
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { extractSpeakerEmbedding } = require('../server/sherpa-diarization.cjs')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback
}
const manifestPath = option('manifest', '')
if (!manifestPath) {
  console.error('缺少 --manifest <file.jsonl>')
  process.exit(1)
}
const threshold = Number(option('threshold', process.env.S2T_VOICEPRINT_THRESHOLD || 0.65))
const margin = Number(option('margin', process.env.S2T_VOICEPRINT_MARGIN || 0.05))
const jsonPath = option('json', '')

const cosine = (left, right) => {
  let dot = 0; let leftNorm = 0; let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

const quantile = (sorted, q) => {
  if (!sorted.length) return NaN
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

const distribution = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted[0],
    p05: quantile(sorted, 0.05),
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1]
  }
}

const show = (label, stats) => `${label}: n=${stats.count} min=${stats.min?.toFixed(3)} p05=${stats.p05?.toFixed(3)} median=${stats.median?.toFixed(3)} p95=${stats.p95?.toFixed(3)} max=${stats.max?.toFixed(3)}`

;(async () => {
  const entries = readFileSync(resolve(manifestPath), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line) } catch { throw new Error(`manifest 第 ${index + 1} 行不是合法 JSON`) }
    })
    .filter((item) => item && typeof item.wav === 'string' && typeof item.nt === 'string' && item.nt.trim())
  if (entries.length < 2) throw new Error('manifest 至少需要 2 筆樣本才能評測')

  const samples = []
  for (const entry of entries) {
    const startedAt = Date.now()
    const embedding = extractSpeakerEmbedding(readFileSync(resolve(entry.wav)))
    samples.push({ wav: entry.wav, nt: entry.nt.trim(), embedding, ms: Date.now() - startedAt })
    console.log(`embedded ${entry.nt} ${entry.wav} (${Date.now() - startedAt} ms)`)
  }

  const same = []
  const different = []
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const score = cosine(samples[left].embedding, samples[right].embedding)
      if (samples[left].nt === samples[right].nt) same.push(score); else different.push(score)
    }
  }

  // Equal Error Rate: the threshold where false accepts == false rejects.
  let eer = { threshold: NaN, far: NaN, frr: NaN, delta: Infinity }
  if (same.length && different.length) {
    const candidates = [...new Set([...same, ...different])].sort((left, right) => left - right)
    for (const candidate of candidates) {
      const far = different.filter((score) => score >= candidate).length / different.length
      const frr = same.filter((score) => score < candidate).length / same.length
      const delta = Math.abs(far - frr)
      if (delta < eer.delta) eer = { threshold: candidate, far, frr, delta }
    }
  }

  // Identification: for each sample, best score per other identity.
  const identityScores = (sample) => {
    const best = new Map()
    for (const other of samples) {
      if (other === sample) continue
      const score = cosine(sample.embedding, other.embedding)
      if (!best.has(other.nt) || best.get(other.nt) < score) best.set(other.nt, score)
    }
    return [...best.entries()].map(([nt, score]) => ({ nt, score })).sort((left, right) => right.score - left.score)
  }
  const decisions = { correct: 0, mismatch: 0, rejected: 0 }
  const mismatched = []
  const rejected = []
  for (const sample of samples) {
    const ranked = identityScores(sample)
    const best = ranked[0]
    const runnerUp = ranked[1]
    if (best && best.score >= threshold && (!runnerUp || best.score - runnerUp.score >= margin)) {
      if (best.nt === sample.nt) decisions.correct += 1
      else { decisions.mismatch += 1; mismatched.push({ wav: sample.wav, expected: sample.nt, got: best.nt, score: Number(best.score.toFixed(3)) }) }
    } else {
      decisions.rejected += 1
      rejected.push({ wav: sample.wav, expected: sample.nt, top1: best ? Number(best.score.toFixed(3)) : null })
    }
  }

  const total = samples.length
  const report = {
    samples: total,
    identities: new Set(samples.map((sample) => sample.nt)).size,
    threshold,
    margin,
    sameSpeaker: same.length ? distribution(same) : null,
    differentSpeaker: different.length ? distribution(different) : null,
    eer: Number.isFinite(eer.threshold) ? { threshold: Number(eer.threshold.toFixed(3)), far: Number(eer.far.toFixed(3)), frr: Number(eer.frr.toFixed(3)) } : null,
    identification: {
      correct: decisions.correct,
      mismatch: decisions.mismatch,
      rejected: decisions.rejected,
      accuracy: Number((decisions.correct / total).toFixed(3)),
      mismatchRate: Number((decisions.mismatch / total).toFixed(3)),
      rejectRate: Number((decisions.rejected / total).toFixed(3))
    },
    mismatched,
    rejected
  }

  console.log('')
  console.log(`samples=${report.samples} identities=${report.identities} threshold=${threshold} margin=${margin}`)
  if (report.sameSpeaker) console.log(show('same-speaker    ', report.sameSpeaker))
  if (report.differentSpeaker) console.log(show('different-speaker', report.differentSpeaker))
  if (report.eer) console.log(`EER point: threshold=${report.eer.threshold} far=${report.eer.far} frr=${report.eer.frr}`)
  console.log(`identification: correct=${decisions.correct} mismatch=${decisions.mismatch} rejected=${decisions.rejected} → accuracy=${report.identification.accuracy} mismatchRate=${report.identification.mismatchRate} rejectRate=${report.identification.rejectRate}`)
  if (mismatched.length) console.log(`mismatched: ${JSON.stringify(mismatched)}`)
  if (jsonPath) {
    writeFileSync(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`report written to ${resolve(jsonPath)}`)
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
