import type { SavedSession } from '../../../shared/types'
import { timestamp, makeTranscriptText } from '../../../shared/services/transcript'

export type DiffRow = { before?: string; after?: string; beforeLine?: number; afterLine?: number; changed: boolean }
export type ComparisonKind = 'transcript' | 'diarization' | 'translation'
const segmentText = (segments: SavedSession['segments'], kind: ComparisonKind): string => {
  if (kind === 'transcript') return segments.filter(segment => segment.status === 'final').map(segment => makeTranscriptText([segment], { includeSpeaker: false, includeTranslation: false })).join('\n')
  return segments.filter(segment => segment.status === 'final' && (kind !== 'translation' || segment.translatedText?.trim())).map(segment =>
    kind === 'diarization'
      ? `[${timestamp(segment.startMs)}–${timestamp(segment.endMs)}] ${segment.speaker?.trim() || '—'}`
      : `[${timestamp(segment.startMs)}] ${segment.translatedText}`
  ).join('\n')
}
export const comparisonText = (session: SavedSession, kind: ComparisonKind = 'transcript'): { before: string; after: string; hasBaseline: boolean } => {
  const active = session.audioVersions?.find(version => version.id === session.activeAudioVersionId)
  const parent = session.audioVersions?.find(version => version.id === active?.parentId)
  const after = session.segments.length ? segmentText(session.segments, kind) : kind === 'transcript' ? session.transcript : ''
  if (parent?.segments !== undefined) return { before: segmentText(parent.segments, kind), after, hasBaseline: true }
  if (kind === 'transcript' && parent?.transcript !== undefined) return { before: parent.transcript, after, hasBaseline: true }
  const hasBaseline = kind === 'transcript' && session.segments.some(segment => segment.correctionOriginalText !== undefined)
  return { before: hasBaseline ? segmentText(session.segments.map(segment => ({ ...segment, sourceText: segment.correctionOriginalText ?? segment.sourceText })), kind) : after, after, hasBaseline }
}

/** Align unchanged lines, then pair changed blocks. Bound work on large transcripts. */
export const comparisonRows = (before: string, after: string): DiffRow[] => {
  const a = before ? before.split(/\r?\n/) : [], b = after ? after.split(/\r?\n/) : []
  const rows: DiffRow[] = []
  if (before === after || !a.length || !b.length || a.length * b.length > 250_000) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) rows.push({ before: a[i], after: b[i], beforeLine: i < a.length ? i + 1 : undefined, afterLine: i < b.length ? i + 1 : undefined, changed: a[i] !== b[i] })
    return rows
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ before: a[i], after: b[j], beforeLine: ++i, afterLine: ++j, changed: false }); continue
    }
    const ai = i, bj = j
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) i++
      else j++
    }
    for (let k = 0; k < Math.max(i - ai, j - bj); k++) rows.push({ before: ai + k < i ? a[ai + k] : undefined, after: bj + k < j ? b[bj + k] : undefined, beforeLine: ai + k < i ? ai + k + 1 : undefined, afterLine: bj + k < j ? bj + k + 1 : undefined, changed: true })
  }
  return rows
}
