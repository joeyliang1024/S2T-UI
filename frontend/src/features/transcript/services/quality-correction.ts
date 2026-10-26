import type { TranscriptEvent } from '../../models/model-adapter'
import { captionGroupSignature, groupLiveCaptions, type LiveCaptionGroup } from '../domain/live-caption'
import { joinCaptionText } from '../../../shared/services/transcript'

/**
 * One correction unit = one merged caption row (合併句) exactly as the viewer
 * sees it: re-transcribing row by row can never collapse two visible rows into
 * one or split a row back into pieces. Row membership already carries the
 * display locks (`captionGroupId`), speaker/language rules and the 10-second /
 * 70-character display limits and 40-character punctuation threshold, so grouping here must not be looser than the
 * screen. Sentence planning has no fixed audio duration of its own.
 */
export const correctionGroups = (entries: TranscriptEvent[], includeOpen = false): LiveCaptionGroup[] =>
  groupLiveCaptions(entries).filter((group, index, groups) =>
    group.status === 'final' && group.sourceText.trim() &&
    (includeOpen || index < groups.length - 1 || group.isSentenceBoundary || /[。！？.!?][」”"']?$/.test(group.sourceText.trim())))

export const correctedCaption = (group: LiveCaptionGroup, text: string): TranscriptEvent => {
  const { members: _, ...entry } = group
  const changed = text !== group.sourceText
  return { ...entry, sourceText: text, correctionOriginalText: group.members.reduce((previous, member) => joinCaptionText(previous, member.correctionOriginalText ?? member.sourceText), ''),
    revision: entry.revision + 1, isSentenceBoundary: true, captionGroupId: entry.captionGroupId ?? entry.id,
    // The merged row carries the joined label; a manual blank anywhere in the
    // row must keep blocking later automatic relabelling of the replacement.
    speakerManuallyEdited: group.members.some(member => member.speakerManuallyEdited),
    ...(changed ? { translatedText: undefined, translationStatus: undefined, translationAttempts: undefined,
      translationContentRevision: (entry.translationContentRevision ?? 0) + 1 } : {}) }
}
export const applySentenceCorrection = (entries: TranscriptEvent[], group: LiveCaptionGroup, text: string): TranscriptEvent[] => {
  const ids = new Set(group.members.map(member => member.id))
  const current = correctionGroups(entries, true).find(item => item.id === group.id)
  // Translation and speaker updates can change revision without changing ASR input.
  if (!current || captionGroupSignature(current) !== captionGroupSignature(group)) return entries
  const replacement = correctedCaption(current, text)
  return entries.flatMap(entry => entry.id === group.id ? [replacement] : ids.has(entry.id) ? [] : [entry])
}

/** Bounded second-pass audio, independent of the recorder and foreground ASR. */
export class CorrectionAudioBuffer {
  private chunks: { start: number; audio: Float32Array }[] = []
  private head = 0
  samples = 0
  constructor(readonly sampleRate: number, private readonly retentionSeconds = 180) {}
  push(audio: Float32Array): void {
    this.chunks.push({ start: this.samples, audio: audio.slice() }); this.samples += audio.length
    const before = this.samples - this.sampleRate * this.retentionSeconds
    while (this.head < this.chunks.length && this.chunks[this.head].start + this.chunks[this.head].audio.length <= before) this.head++
    // Compact occasionally rather than shifting tens of thousands of worklet frames per push.
    if (this.head >= 4096 && this.head >= this.chunks.length / 2) {
      this.chunks = this.chunks.slice(this.head); this.head = 0
    }
  }
  slice(startMs: number, endMs: number): Float32Array | null {
    const start = Math.max(0, Math.floor(startMs * this.sampleRate / 1000))
    const requestedEnd = Math.ceil(endMs * this.sampleRate / 1000)
    // ASR timestamps are rounded to milliseconds; allow only that rounding at the tail.
    if (requestedEnd > this.samples + Math.ceil(this.sampleRate / 1000)) return null
    const end = Math.min(requestedEnd, this.samples)
    if (end <= start || start < (this.chunks[this.head]?.start ?? this.samples)) return null
    const output = new Float32Array(end - start)
    for (let index = this.head; index < this.chunks.length; index++) {
      const chunk = this.chunks[index]
      const left = Math.max(start, chunk.start), right = Math.min(end, chunk.start + chunk.audio.length)
      if (right > left) output.set(chunk.audio.subarray(left - chunk.start, right - chunk.start), left - start)
    }
    return output
  }
}

/** Highlight inserted/replaced characters with a bounded LCS diff. */
export const correctionRuns = (before: string, after: string): { text: string; changed: boolean }[] => {
  const a = Array.from(before), b = Array.from(after)
  if (before === after) return [{ text: after, changed: false }]
  if (a.length * b.length > 1_000_000) return [{ text: after, changed: true }]
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  const matched = new Set<number>(); let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { matched.add(j); i++; j++ }
    else if (rows[i + 1][j] >= rows[i][j + 1]) i++
    else j++
  }
  const runs: { text: string; changed: boolean }[] = []
  b.forEach((char, index) => {
    const changed = !matched.has(index), last = runs[runs.length - 1]
    if (last?.changed === changed) last.text += char
    else runs.push({ text: char, changed })
  })
  return runs
}
