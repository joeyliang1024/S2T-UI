import type { TranscriptEvent } from '../models/model-adapter'

export type SpeakerTurn = { startMs: number; endMs: number; speaker: string }

/** A caption span that may already carry a label from an earlier window. */
export type CaptionSpan = { startMs: number; endMs: number; speaker?: string }

const overlap = (left: SpeakerTurn, right: SpeakerTurn): number => Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs))

const ANONYMOUS_LABEL = /^SPEAKER_(\d+)$/
const labelNumber = (label: string): number => Number(ANONYMOUS_LABEL.exec(label)?.[1] ?? -1)
const isAnonymous = (label: string): boolean => labelNumber(label) >= 0

/** Shared by caption assignment and caption continuity — keep them in step. */
const COVER_FLOOR = 0.35

/**
 * The label explaining the greatest share of a span, provided it explains a
 * meaningful portion of it. A turn that merely touches a boundary is noise.
 */
const coveringLabel = (span: CaptionSpan, turns: SpeakerTurn[]): string | undefined => {
  let best: SpeakerTurn | undefined
  let greatest = 0
  for (const turn of turns) {
    const shared = Math.max(0, Math.min(span.endMs, turn.endMs) - Math.max(span.startMs, turn.startMs))
    if (shared > greatest) { greatest = shared; best = turn }
  }
  return best && greatest / Math.max(1, span.endMs - span.startMs) >= COVER_FLOOR ? best.speaker : undefined
}

/**
 * Hungarian assignment (Jonker–Volgenant) maximising total weight, returned as
 * a column index per row or -1 when the row is left unmatched. Cross-checked
 * against a brute-force search by `npm run diarization:smoke`.
 */
export const maxAssignment = (weight: number[][]): number[] => {
  const rows = weight.length
  const cols = rows ? weight[0].length : 0
  const size = Math.max(rows, cols)
  if (!size) return []
  const cost = Array.from({ length: size + 1 }, () => new Array<number>(size + 1).fill(0))
  for (let index = 1; index <= rows; index += 1) {
    for (let column = 1; column <= cols; column += 1) cost[index][column] = -weight[index - 1][column - 1]
  }
  const u = new Float64Array(size + 1); const v = new Float64Array(size + 1)
  const pair = new Int32Array(size + 1); const way = new Int32Array(size + 1)
  for (let row = 1; row <= size; row += 1) {
    pair[0] = row
    let column = 0
    const minv = new Float64Array(size + 1).fill(Number.POSITIVE_INFINITY)
    const used = new Uint8Array(size + 1)
    do {
      used[column] = 1
      const current = pair[column]
      let delta = Number.POSITIVE_INFINITY
      let next = 0
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue
        const adjusted = cost[current][candidate] - u[current] - v[candidate]
        if (adjusted < minv[candidate]) { minv[candidate] = adjusted; way[candidate] = column }
        if (minv[candidate] < delta) { delta = minv[candidate]; next = candidate }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) { u[pair[candidate]] += delta; v[candidate] -= delta } else { minv[candidate] -= delta }
      }
      column = next
    } while (pair[column] !== 0)
    do { const previous = way[column]; pair[column] = pair[previous]; column = previous } while (column !== 0)
  }
  const assigned = new Int32Array(rows + 1).fill(-1)
  for (let column = 1; column <= size; column += 1) if (pair[column] > 0 && pair[column] <= rows) assigned[pair[column]] = column
  return Array.from({ length: rows }, (_, index) => {
    const column = assigned[index + 1]
    return column >= 1 && column <= cols ? column - 1 : -1
  })
}

/**
 * Cosine gate for the voice term — the knee of the trade-off recorded in §12.6
 * of VOICEPRINT_ACCURACY: dropping to 0.6 costs 6.4 pp of label purity, raising
 * to 0.8 keeps only a ninth of the churn it removed.
 */
const VOICE_GATE = 0.7
/** 5 × cosine ≈ 4 caption-seconds, so a clear voice match outranks a short caption. */
const VOICE_WEIGHT = 5

const cosine = (left: number[] | undefined, right: number[] | undefined): number => {
  if (!left || !right || left.length !== right.length) return -1
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1
}

export type StabilizeOptions = {
  /** Caption spans that may already carry a label from an earlier window. */
  captions?: CaptionSpan[]
  /** Window-local label → vector, as delivered by the preview response. */
  embeddings?: Record<string, number[]>
  /** Stable label → running vector. Written in place with this window's vectors. */
  centroids?: Map<string, number[]>
}

/**
 * Sliding windows restart anonymous numbering, so the same person changes
 * SPEAKER_XX from one window to the next.
 *
 * The old rule — give each incoming label whichever prior turn overlaps the
 * most — picks a different anchor every time the window slides, which is what
 * the flicker traced back to (§12.2 of VOICEPRINT_ACCURACY: 51% of label churn
 * was "best overlap moved to somebody else", 38% had no overlap at all, and
 * only 1/55 events would have been saved by falling back to the second best
 * anchor). Matching every incoming label at once, weighted by the captions that
 * already name that person, by overlap as a tie break, and by voiceprint
 * similarity where it is confident enough, keeps a label stable without needing
 * more of the audio to overlap.
 *
 * Identity recognition stays out of it: recognized labels are never rewritten,
 * and an old NT match is never enough to name a fresh anonymous window.
 */
export const stabilizeSpeakerTurns = (
  previous: SpeakerTurn[],
  incoming: SpeakerTurn[],
  options: StabilizeOptions = {}
): SpeakerTurn[] => {
  const captions = options.captions ?? []
  const embeddings = options.embeddings ?? {}
  const centroids = options.centroids
  const rawLabels = [...new Set(incoming.map((turn) => turn.speaker).filter(isAnonymous))]
  if (!rawLabels.length) return incoming

  // Candidate names come from both sources: prior turns for temporal evidence,
  // captions for continuity. Including captions also keeps minting from
  // reusing a number an older, pruned turn once handed out.
  const priorLabels = [...new Set([
    ...previous.map((turn) => turn.speaker).filter(isAnonymous),
    ...captions.map((caption) => caption.speaker ?? '').filter(isAnonymous)
  ])]

  const incomingByLabel = new Map<string, SpeakerTurn[]>()
  for (const turn of incoming) {
    if (!isAnonymous(turn.speaker)) continue
    const bucket = incomingByLabel.get(turn.speaker)
    if (bucket) bucket.push(turn); else incomingByLabel.set(turn.speaker, [turn])
  }
  const previousByLabel = new Map<string, SpeakerTurn[]>()
  for (const turn of previous) {
    if (!isAnonymous(turn.speaker)) continue
    const bucket = previousByLabel.get(turn.speaker)
    if (bucket) bucket.push(turn); else previousByLabel.set(turn.speaker, [turn])
  }

  // Continuity: a caption already carrying a name lends its whole duration to
  // the incoming label covering it now. Unlike raw overlap this signal does
  // not depend on how much of the prior window survived into this one.
  const continuity = new Map<string, Map<string, number>>()
  for (const caption of captions) {
    const held = caption.speaker
    if (!held || !isAnonymous(held)) continue
    const label = coveringLabel(caption, incoming)
    if (!label || !incomingByLabel.has(label)) continue
    const row = continuity.get(label) ?? new Map<string, number>()
    row.set(held, (row.get(held) ?? 0) + (caption.endMs - caption.startMs) / 1000)
    continuity.set(label, row)
  }

  // Seconds throughout: caption seconds and sqrt(overlap seconds) carry the
  // same weight order that measured best (§12.3). The voice term is the only
  // signal that still works when the window carries no overlap at all — the
  // 38% of churn events that had no anchor to begin with.
  const weight = rawLabels.map((label) => priorLabels.map((prior) => {
    let shared = 0
    const nexts = incomingByLabel.get(label)
    const priors = previousByLabel.get(prior)
    if (nexts && priors) for (const next of nexts) for (const turn of priors) shared += overlap(next, turn)
    const score = (continuity.get(label)?.get(prior) ?? 0) + Math.sqrt(shared / 1000)
    if (!centroids) return score
    const similarity = cosine(embeddings[label], centroids.get(prior))
    return similarity >= VOICE_GATE ? score + VOICE_WEIGHT * similarity : score
  }))

  const match = maxAssignment(weight)
  let nextAnonymous = priorLabels.reduce((maximum, prior) => Math.max(maximum, labelNumber(prior)), -1) + 1
  const mapping = new Map<string, string>()
  const claimed = new Set<string>()
  rawLabels.forEach((label, index) => {
    const target = match[index]
    if (target >= 0 && weight[index][target] > 0 && !claimed.has(priorLabels[target])) {
      mapping.set(label, priorLabels[target])
      claimed.add(priorLabels[target])
      return
    }
    const name = `SPEAKER_${String(nextAnonymous++).padStart(2, '0')}`
    mapping.set(label, name)
    claimed.add(name)
  })

  // Vectors are fused after matching, so a name is only ever compared against
  // what earlier windows established about it — never against this window's
  // own answer, which would make the voice term tautological.
  if (centroids) {
    for (const label of rawLabels) {
      const vector = embeddings[label]
      const stable = mapping.get(label)
      if (vector && stable) centroids.set(stable, vector)
    }
  }

  return incoming.map((turn) => {
    if (!isAnonymous(turn.speaker)) return turn
    const stable = mapping.get(turn.speaker)
    return stable && stable !== turn.speaker ? { ...turn, speaker: stable } : turn
  })
}

/**
 * Assign each ASR segment the diarization speaker with the greatest temporal
 * overlap. This mirrors the reconciliation step used by diarization pipelines:
 * the ASR segment's timestamp remains authoritative for subtitle rendering.
 */
export const assignSpeakersByOverlap = (entries: TranscriptEvent[], turns: SpeakerTurn[]): TranscriptEvent[] => entries.map((entry) => {
  if (entry.status !== 'final' || entry.speakerManuallyEdited) return entry
  let assigned: SpeakerTurn | undefined
  let greatestOverlap = 0
  for (const turn of turns) {
    const overlap = Math.max(0, Math.min(entry.endMs, turn.endMs) - Math.max(entry.startMs, turn.startMs))
    if (overlap > greatestOverlap) { greatestOverlap = overlap; assigned = turn }
  }
  // A diarization turn that merely touches a subtitle boundary is unreliable.
  // Require it to explain a meaningful portion of the caption before labeling.
  const coverage = greatestOverlap / Math.max(1, entry.endMs - entry.startMs)
  return assigned && coverage >= 0.35 && entry.speaker !== assigned.speaker ? { ...entry, speaker: assigned.speaker, revision: entry.revision + 1 } : entry
})

export const parseSpeakerTurns = (payload: unknown): SpeakerTurn[] => {
  if (!payload || typeof payload !== 'object') return []
  const source = payload as { segments?: unknown[]; diarization?: unknown[]; exclusive_diarization?: unknown[] }
  const raw = source.exclusive_diarization ?? source.segments ?? source.diarization ?? []
  return raw.flatMap((item): SpeakerTurn[] => {
    if (!item || typeof item !== 'object') return []
    const turn = item as { start?: unknown; end?: unknown; start_ms?: unknown; end_ms?: unknown; speaker?: unknown }
    const start = typeof turn.start_ms === 'number' ? turn.start_ms : typeof turn.start === 'number' ? Math.round(turn.start * 1000) : NaN
    const end = typeof turn.end_ms === 'number' ? turn.end_ms : typeof turn.end === 'number' ? Math.round(turn.end * 1000) : NaN
    return Number.isFinite(start) && Number.isFinite(end) && end > start && typeof turn.speaker === 'string' && turn.speaker.trim()
      ? [{ startMs: start, endMs: end, speaker: turn.speaker.trim().slice(0, 80) }] : []
  })
}

/**
 * Per-label voiceprint vectors from the preview response (§12.8 of
 * VOICEPRINT_ACCURACY). They are strictly advisory: a missing, short or
 * non-numeric map leaves the voice term off and the stabilizer keeps working
 * on captions plus overlap, which is exactly what it had before.
 */
export const parseSpeakerEmbeddings = (payload: unknown): Record<string, number[]> => {
  if (!payload || typeof payload !== 'object') return {}
  const raw = (payload as { speaker_embeddings?: unknown }).speaker_embeddings
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const output: Record<string, number[]> = {}
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^SPEAKER_\d+$/.test(label) || !Array.isArray(value) || value.length < 16) continue
    const vector = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    if (vector.length === value.length) output[label.slice(0, 80)] = vector
  }
  return output
}
