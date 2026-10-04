const assert = require('node:assert/strict')
const { readdirSync, readFileSync, existsSync } = require('node:fs')
const { buildSync } = require('esbuild')

// Bundles the real renderer module so the assertions run against production
// code, not a copy of it.
const result = buildSync({ entryPoints: ['src/renderer/src/features/speakers/diarization.ts'], bundle: true, format: 'cjs', platform: 'node', write: false })
const LoadedModule = module.constructor
const loaded = new LoadedModule('label-stability-module')
loaded.filename = 'label-stability-module.cjs'
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, loaded.filename)
const { maxAssignment, stabilizeSpeakerTurns, assignSpeakersByOverlap, parseSpeakerEmbeddings } = loaded.exports

// ---------------------------------------------------------------- deterministic random
let seed = 0x2f6e2b1
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}

// ---------------------------------------------------------------- assignment selftest
const bruteForce = (weight) => {
  const rows = weight.length
  const cols = rows ? weight[0].length : 0
  let best = -Infinity
  let bestChoice = null
  const walk = (row, used, total, choice) => {
    if (row === rows) {
      if (total > best) { best = total; bestChoice = [...choice] }
      return
    }
    choice.push(-1)
    walk(row + 1, used, total, choice)
    choice.pop()
    for (let column = 0; column < cols; column += 1) {
      if (used.has(column)) continue
      used.add(column)
      choice.push(column)
      walk(row + 1, used, total + weight[row][column], choice)
      choice.pop()
      used.delete(column)
    }
  }
  walk(0, new Set(), 0, [])
  return bestChoice
}

for (let round = 0; round < 300; round += 1) {
  const rows = 1 + Math.floor(random() * 5)
  const cols = 1 + Math.floor(random() * 5)
  const weight = Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.round(random() * 1000) / 100))
  const greedy = maxAssignment(weight)
  const expected = bruteForce(weight)
  let actual = 0
  for (let row = 0; row < rows; row += 1) if (greedy[row] >= 0) actual += weight[row][greedy[row]]
  let wanted = 0
  for (let row = 0; row < rows; row += 1) if (expected[row] >= 0) wanted += weight[row][expected[row]]
  assert.ok(Math.abs(actual - wanted) < 1e-9, `assignment must be optimal, got ${actual} want ${wanted}`)
  const usedColumns = greedy.filter((column) => column >= 0)
  assert.equal(new Set(usedColumns).size, usedColumns.length, 'assignment must be one-to-one')
}
assert.deepEqual(maxAssignment([]), [], 'an empty matrix has nothing to match')

// ---------------------------------------------------------------- invariants
const turn = (startSec, endSec, speaker) => ({ startMs: startSec * 1000, endMs: endSec * 1000, speaker })
const caption = (startSec, endSec, speaker) => ({ startMs: startSec * 1000, endMs: endSec * 1000, speaker })

// A caption already naming SPEAKER_04 wins over the larger raw overlap with
// SPEAKER_09: continuity is what stops the anchor sliding to a neighbour.
const anchored = stabilizeSpeakerTurns(
  [turn(0, 40, 'SPEAKER_04'), turn(40, 80, 'SPEAKER_09')],
  [turn(30, 60, 'SPEAKER_00'), turn(60, 90, 'SPEAKER_01')],
  { captions: [caption(31, 45, 'SPEAKER_04'), caption(61, 75, 'SPEAKER_09')] }
)
assert.equal(anchored[0].speaker, 'SPEAKER_04', 'a caption naming a person must anchor the incoming label')
assert.equal(anchored[1].speaker, 'SPEAKER_09', 'the other caption anchors its own label')
assert.equal(new Set(anchored.map((item) => item.speaker)).size, anchored.length, 'two incoming labels must never share one stable label')

// Recognized labels are never rewritten, and an old NT match never names a
// fresh anonymous window — both behaviours predate this rule and must hold.
assert.equal(stabilizeSpeakerTurns([turn(0, 20, 'NT-1234')], [turn(5, 12, 'SPEAKER_00')])[0].speaker, 'SPEAKER_00', 'an old identity match must not relabel a new anonymous window')
assert.equal(stabilizeSpeakerTurns([], [turn(5, 12, 'NT-1234')])[0].speaker, 'NT-1234', 'recognized labels pass through untouched')

// A label with real evidence takes the prior name; one with none mints above
// every known number instead of stealing a name it cannot support.
assert.equal(stabilizeSpeakerTurns([turn(55, 75, 'SPEAKER_07')], [turn(60, 70, 'SPEAKER_00')])[0].speaker, 'SPEAKER_07', 'a label with real temporal evidence takes the prior name')
assert.equal(stabilizeSpeakerTurns([turn(0, 3, 'SPEAKER_07')], [turn(60, 70, 'SPEAKER_00')])[0].speaker, 'SPEAKER_08', 'a label with no evidence mints above every known number')
const unmatched = stabilizeSpeakerTurns([turn(0, 3, 'SPEAKER_07')], [turn(60, 70, 'SPEAKER_00'), turn(70, 80, 'SPEAKER_01')], { captions: [caption(61, 65, 'SPEAKER_07')] })
assert.equal(unmatched[0].speaker, 'SPEAKER_07', 'caption continuity must claim the prior name')
assert.equal(unmatched[1].speaker, 'SPEAKER_08', 'the label with no evidence is minted above every known number')

// Minting must never hand out a number a caption still wears.
const collision = stabilizeSpeakerTurns(
  [turn(0, 10, 'SPEAKER_01'), turn(10, 20, 'SPEAKER_04')],
  [turn(60, 70, 'SPEAKER_00'), turn(70, 80, 'SPEAKER_01')],
  { captions: [caption(61, 65, 'SPEAKER_04')] }
)
assert.equal(new Set(collision.map((item) => item.speaker)).size, collision.length, 'minted numbers must not collide with a caption label')

// ------------------------------------------------------------- voice term
const vector = (seed, length = 32) => Array.from({ length }, (_, index) => Math.cos(seed + index * 0.37) + seed * 0.01)
const assertEmbedding = (payload, expected) => {
  const parsed = parseSpeakerEmbeddings(payload)
  assert.equal(Object.keys(parsed).length, expected, 'only well-formed label vectors survive parsing')
  return parsed
}
assertEmbedding({ speaker_embeddings: { SPEAKER_00: vector(1), SPEAKER_01: vector(2) } }, 2)
assert.deepEqual(parseSpeakerEmbeddings({}), {}, 'a response without voiceprints leaves the voice term off')
assert.deepEqual(parseSpeakerEmbeddings({ speaker_embeddings: { SPEAKER_00: [1, 2, 3] } }), {}, 'a stub vector is not evidence')
assert.deepEqual(parseSpeakerEmbeddings({ speaker_embeddings: { SPEAKER_00: [...vector(1, 32).slice(0, 31), 'oops'] } }), {}, 'a partially numeric vector is not evidence')
assert.deepEqual(parseSpeakerEmbeddings({ speaker_embeddings: { 'NT-1234': vector(1) } }), {}, 'recognized labels are never restamped, so they carry no vector here')

// The 38% of churn events with no caption and no overlap: voice is the only
// signal left, and it must be able to claim the prior name on its own.
const identical = vector(1)
const centroids = new Map([['SPEAKER_04', identical]])
const voiced = stabilizeSpeakerTurns(
  [turn(0, 40, 'SPEAKER_04')],
  [turn(60, 70, 'SPEAKER_00')],
  { embeddings: { SPEAKER_00: identical }, centroids }
)
assert.equal(voiced[0].speaker, 'SPEAKER_04', 'a confident voice match must name an otherwise unanchored label')
assert.deepEqual(centroids.get('SPEAKER_04'), identical, 'the stable label keeps the vector it was matched on')

// Below the gate the term contributes nothing, so an unrelated voice cannot
// talk its way onto somebody else's name. The negative of a vector is
// guaranteed to sit at cosine −1, well under the 0.7 gate.
const unrelated = vector(1).map((value) => -value)
const indifferent = stabilizeSpeakerTurns(
  [turn(0, 40, 'SPEAKER_04')],
  [turn(60, 70, 'SPEAKER_00')],
  { embeddings: { SPEAKER_00: unrelated }, centroids: new Map([['SPEAKER_04', vector(1)]]) }
)
assert.equal(indifferent[0].speaker, 'SPEAKER_05', 'a similarity under the 0.7 gate must not carry a match on its own')

// Vectors land after matching, so this window's answer never validates itself.
const self = new Map()
const seeded = stabilizeSpeakerTurns([turn(0, 40, 'SPEAKER_04')], [turn(60, 70, 'SPEAKER_00')], { embeddings: { SPEAKER_00: vector(5) }, centroids: self })
assert.equal(seeded[0].speaker, 'SPEAKER_05', 'an empty centroid map offers no evidence on the first window')
assert.ok(self.has('SPEAKER_05'), 'the window vector is recorded under the name it minted')

// No captions and no overlap: nothing to match on, so every label mints.
const cold = stabilizeSpeakerTurns([], [turn(0, 10, 'SPEAKER_00'), turn(10, 20, 'SPEAKER_01')])
assert.deepEqual(cold.map((item) => item.speaker), ['SPEAKER_00', 'SPEAKER_01'], 'a cold start mints from zero')

// ---------------------------------------------------------------- corpus replay
const COVER_FLOOR = 0.35
const coveringLabel = (span, turns) => {
  let best = null
  let greatest = 0
  for (const item of turns) {
    const shared = Math.max(0, Math.min(span.endMs, item.endMs) - Math.max(span.startMs, item.startMs))
    if (shared > greatest) { greatest = shared; best = item }
  }
  return best && greatest / Math.max(1, span.endMs - span.startMs) >= COVER_FLOOR ? best.speaker : null
}

// The greedy rule this replaced, kept inline so the comparison needs no git.
const legacy = (previous, incoming) => {
  const stable = new Map()
  for (const next of incoming) {
    for (const prior of previous) {
      if (!/^SPEAKER_\d+$/.test(prior.speaker)) continue
      const amount = Math.max(0, Math.min(next.endMs, prior.endMs) - Math.max(next.startMs, prior.startMs))
      if (!amount) continue
      const known = stable.get(next.speaker)
      if (!known || amount > known.amount) stable.set(next.speaker, { speaker: prior.speaker, amount })
    }
  }
  const allocated = new Map()
  let next = previous.reduce((maximum, item) => Math.max(maximum, Number(/^SPEAKER_(\d+)$/.exec(item.speaker)?.[1] ?? -1)), -1) + 1
  const claimed = new Set()
  return incoming.map((item) => {
    if (!/^SPEAKER_\d+$/.test(item.speaker)) return item
    const target = stable.get(item.speaker)?.speaker
    if (allocated.has(item.speaker)) return { ...item, speaker: allocated.get(item.speaker) }
    if (target && !claimed.has(target)) { claimed.add(target); allocated.set(item.speaker, target); return { ...item, speaker: target } }
    const name = allocated.get(item.speaker) ?? `SPEAKER_${String(next++).padStart(2, '0')}`
    allocated.set(item.speaker, name)
    return { ...item, speaker: name }
  })
}

const emptyBucket = () => ({ flips: 0, opportunities: 0, speakerFlips: 0, speakerOpportunities: 0, distinct: 0, puritySum: 0, purityFiles: 0 })

const replay = (cache, stabilize) => {
  let captions = cache.truth.map((row) => ({ id: `row-${row.start}`, revision: 0, status: 'final', startMs: Math.round(row.start * 1000), endMs: Math.round(row.end * 1000), sourceText: row.speaker }))
  const perTick = []
  let previous = []
  for (const tick of cache.ticks) {
    const clipStart = Math.round(tick.startSec * 1000)
    const incoming = tick.turns.map((item) => ({ startMs: Math.round(item.start * 1000), endMs: Math.round(item.end * 1000), speaker: item.speaker }))
    const turns = stabilize(previous, incoming, { captions, embeddings: tick.embeddings })
    perTick.push(turns)
    previous = [...previous.filter((item) => item.endMs >= clipStart - 5_000), ...turns]
    if (turns.length) captions = assignSpeakersByOverlap(captions, turns)
  }
  return { perTick }
}

const measure = (cache, run) => {
  const bucket = emptyBucket()
  const windows = cache.ticks.map((tick) => ({ start: tick.startSec, end: tick.endSec }))
  // Label a row from each window's own turns — stored caption labels go stale
  // the moment the window moves on, which would hide real churn.
  const labelled = run.perTick.map((turns, tick) => cache.truth.map((row) => {
    const mid = (row.start + row.end) / 2
    if (mid < windows[tick].start || mid >= windows[tick].end) return null
    return coveringLabel({ startMs: Math.round(row.start * 1000), endMs: Math.round(row.end * 1000) }, turns)
  }))

  const observed = new Set()
  cache.truth.forEach((row, index) => {
    if (labelled.some((tickLabels) => tickLabels[index])) observed.add(index)
  })
  for (const index of observed) {
    let prior = null
    for (let tick = 0; tick < labelled.length; tick += 1) {
      const label = labelled[tick][index]
      if (!label) continue
      if (prior !== null) { bucket.opportunities += 1; if (prior !== label) bucket.flips += 1 }
      prior = label
    }
  }

  // Per truth speaker → tick → majority label. Ties resolve by row count, and
  // churn is measured between consecutive appearances, not consecutive ticks.
  const perSpeaker = new Map()
  const purity = new Map()
  labelled.forEach((tickLabels, tick) => {
    cache.truth.forEach((row, index) => {
      const label = tickLabels[index]
      if (!label) return
      const bySpeaker = purity.get(label) || new Map()
      bySpeaker.set(row.speaker, (bySpeaker.get(row.speaker) || 0) + (row.end - row.start))
      purity.set(label, bySpeaker)
      const holder = perSpeaker.get(row.speaker) || new Map()
      perSpeaker.set(row.speaker, holder)
      const byLabel = holder.get(tick) || new Map()
      holder.set(tick, byLabel)
      byLabel.set(label, (byLabel.get(label) || 0) + 1)
    })
  })
  for (const holder of perSpeaker.values()) {
    const appearances = [...holder.keys()].sort((a, b) => a - b)
    const winner = (tick) => {
      let label = null
      let most = -1
      for (const [candidate, count] of holder.get(tick)) if (count > most) { most = count; label = candidate }
      return label
    }
    for (let index = 1; index < appearances.length; index += 1) {
      bucket.speakerOpportunities += 1
      if (winner(appearances[index]) !== winner(appearances[index - 1])) bucket.speakerFlips += 1
    }
  }

  bucket.distinct = new Set(run.perTick.flat().map((item) => item.speaker)).size
  let total = 0
  let kept = 0
  for (const bySpeaker of purity.values()) {
    let seconds = 0
    let best = 0
    for (const value of bySpeaker.values()) { seconds += value; if (value > best) best = value }
    total += seconds
    kept += best
  }
  if (total) { bucket.puritySum = kept / total; bucket.purityFiles = 1 }
  return bucket
}

const add = (target, bucket) => {
  target.flips += bucket.flips
  target.opportunities += bucket.opportunities
  target.speakerFlips += bucket.speakerFlips
  target.speakerOpportunities += bucket.speakerOpportunities
  target.distinct += bucket.distinct
  target.puritySum += bucket.puritySum
  target.purityFiles += bucket.purityFiles
}

const fmt = (bucket) => `句翻轉 ${String(bucket.flips).padStart(3)}/${String(bucket.opportunities).padEnd(3)}  語者跳動 ${String(bucket.speakerFlips).padStart(3)}/${String(bucket.speakerOpportunities).padEnd(3)}  distinct ${String(bucket.distinct).padStart(3)}  標籤純度 ${(100 * bucket.puritySum / Math.max(1, bucket.purityFiles)).toFixed(1)}%`

const cacheDir = 'tmp/cache'
const files = existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.endsWith('.json')).sort() : []
if (files.length === 0) {
  console.log('No cached preview windows under tmp/cache — synthetic assertions only.')
} else {
  const totals = { legacy: emptyBucket(), stable: emptyBucket(), voiced: emptyBucket() }
  const verbose = process.argv.includes('--verbose')
  if (verbose) console.log('  檔名        現行 句翻/跳   +caption 句翻/跳   +voice 句翻/跳   distinct 現→cap→vox')
  for (const name of files) {
    const cache = JSON.parse(readFileSync(`${cacheDir}/${name}`, 'utf8'))
    const before = measure(cache, replay(cache, (previous, incoming) => legacy(previous, incoming)))
    const after = measure(cache, replay(cache, (previous, incoming, options) => stabilizeSpeakerTurns(previous, incoming, { captions: options.captions })))
    // One centroid map per recording, exactly as the controller holds it.
    const centroids = new Map()
    const voice = measure(cache, replay(cache, (previous, incoming, options) => stabilizeSpeakerTurns(previous, incoming, { captions: options.captions, embeddings: options.embeddings, centroids })))
    if (verbose) {
      const pair = (bucket) => `${String(bucket.flips).padStart(2)}/${String(bucket.opportunities).padEnd(3)} ${String(bucket.speakerFlips).padStart(2)}/${String(bucket.speakerOpportunities).padEnd(3)} `
      const spread = (bucket) => String(bucket.distinct).padStart(3)
      console.log(`  ${name.padEnd(12)} ${pair(before)} ${pair(after)} ${pair(voice)}   ${spread(before)}→${spread(after)}→${spread(voice)}`)
    }
    add(totals.legacy, before)
    add(totals.stable, after)
    add(totals.voiced, voice)
  }
  console.log(`Replayed ${files.length} cached windows.`)
  console.log(`  legacy greedy  : ${fmt(totals.legacy)}`)
  console.log(`  caption anchor : ${fmt(totals.stable)}`)
  console.log(`  + voice@0.7    : ${fmt(totals.voiced)}`)
  assert.ok(totals.stable.speakerFlips <= totals.legacy.speakerFlips, `speaker churn must not regress: ${totals.stable.speakerFlips} > ${totals.legacy.speakerFlips}`)
  assert.ok(totals.stable.flips <= totals.legacy.flips, `caption flips must not regress: ${totals.stable.flips} > ${totals.legacy.flips}`)
  assert.ok(totals.voiced.speakerFlips <= totals.legacy.speakerFlips, `voice must not add churn: ${totals.voiced.speakerFlips} > ${totals.legacy.speakerFlips}`)
  assert.ok(totals.voiced.speakerFlips <= totals.stable.speakerFlips, `voice must beat captions alone: ${totals.voiced.speakerFlips} > ${totals.stable.speakerFlips}`)
  assert.ok(totals.voiced.flips <= totals.legacy.flips, `voice must not flip more captions than the old rule: ${totals.voiced.flips} > ${totals.legacy.flips}`)
}

console.log('Speaker label stability smoke test passed.')
