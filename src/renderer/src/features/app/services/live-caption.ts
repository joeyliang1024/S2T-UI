import type { TranscriptEvent } from '../../models/model-adapter'
import { joinCaptionText } from '../../../shared/services/transcript'

export const upsertLiveCaption = (current: TranscriptEvent[], event: TranscriptEvent, _clearedThroughMs: number, _isTranslating: (id: string) => boolean): TranscriptEvent[] => {
  const existing = current.findIndex((entry) => entry.id === event.id)
  if (existing < 0) {
    return [...current, { ...event, asrRevision: event.revision }].sort((a, b) => a.startMs - b.startMs)
  }
  const next = [...current]
  const previous = next[existing]
  if (event.revision >= (previous.asrRevision ?? previous.revision)) {
    const changed = previous.sourceText !== event.sourceText || previous.detectedLanguage !== event.detectedLanguage || previous.translatedText !== event.translatedText
    const sameSpan = previous.startMs === event.startMs && previous.endMs === event.endMs
    const speaker = previous.speakerManuallyEdited ? previous.speaker : event.speaker ?? (sameSpan ? previous.speaker : undefined)
    next[existing] = { ...event, asrRevision: event.revision, revision: Math.max(previous.revision, event.revision),
      captionGroupId: previous.captionGroupId, speaker, speakerManuallyEdited: previous.speakerManuallyEdited, translationContentRevision: (previous.translationContentRevision ?? 0) + (changed ? 1 : 0) }
  }
  return next
}

export const renderedLiveCaptionWindow = (entries: TranscriptEvent[], searching = false): TranscriptEvent[] => searching ? entries : entries.slice(-500)

export const editCaptionContent = (entry: TranscriptEvent, sourceText: string, translatedText?: string): TranscriptEvent => {
  const sourceChanged = entry.sourceText !== sourceText
  const providedTranslation = translatedText || undefined
  const nextTranslation = sourceChanged && providedTranslation === entry.translatedText ? undefined : providedTranslation
  return { ...entry, sourceText, translatedText: nextTranslation, translationStatus: undefined, translationAttempts: undefined,
    translationContentRevision: (entry.translationContentRevision ?? 0) + 1, revision: entry.revision + 1, status: 'final' }
}

/** Presentation only: members remain the canonical records used by editing,
 * translation, storage and export. No timer or model request is introduced. */
export type LiveCaptionGroup = TranscriptEvent & { members: TranscriptEvent[] }

export const groupLiveCaptions = (entries: TranscriptEvent[], ignoreSpeakers = false): LiveCaptionGroup[] => {
  const groups: LiveCaptionGroup[] = []
  for (const entry of entries) {
    const previous = groups[groups.length - 1]
    const chars = previous ? Array.from(previous.sourceText.replace(/[\s\p{P}]/gu, '')).length : 0
    const terminal = previous && /[。！？.!?][」”"']?$/.test(previous.sourceText.trim())
    const last = previous?.members[previous.members.length - 1]
    // A missing label means pending identification, not a speaker change.
    // Retain a known group label across pending members so A / pending / B
    // still splits when B is confirmed. Canonical member labels stay intact.
    const previousExplicitBlank = previous?.members.some(member => member.speakerManuallyEdited && !member.speaker)
    const compatibleSpeaker = previous && (previous.speaker === entry.speaker ||
      (!previous.speaker && !previousExplicitBlank) || (!entry.speaker && !entry.speakerManuallyEdited))
    const lockedTogether = Boolean(previous?.captionGroupId && previous.captionGroupId === entry.captionGroupId)
    const differentGroups = Boolean(previous?.captionGroupId || entry.captionGroupId) && !lockedTogether
    const canJoin = previous && previous.status !== 'gap' && entry.status !== 'gap' && !differentGroups && (lockedTogether || (
      entry.startMs >= (last?.startMs ?? 0) && entry.startMs - previous.endMs < 600 &&
      !previous.isSentenceBoundary && entry.endMs - previous.startMs <= 10_000 &&
      chars < 70 && (!terminal || chars < 24) &&
      (ignoreSpeakers || compatibleSpeaker) && previous.detectedLanguage === entry.detectedLanguage))
    if (canJoin) {
      previous.members.push(entry)
      const labels = [...new Set(previous.members.map(member => member.speaker).filter(Boolean))]
      previous.speaker = labels.length ? labels.join(' / ') : undefined
      previous.sourceText = joinCaptionText(previous.sourceText, entry.sourceText)
      if (entry.translatedText) previous.translatedText = joinCaptionText(previous.translatedText ?? '', entry.translatedText)
      previous.endMs = Math.max(previous.endMs, entry.endMs)
      previous.isSentenceBoundary = entry.isSentenceBoundary
      previous.status = previous.members.some(member => member.status === 'partial') ? 'partial' : 'final'
    } else groups.push({ ...entry, members: [entry] })
  }
  return groups
}

/** Completed means the row has a successor or an explicit ASR/VAD boundary. */
export const completedCaptionGroups = (entries: TranscriptEvent[], includeOpen = false): LiveCaptionGroup[] => {
  const groups = groupLiveCaptions(entries, true)
  return groups.filter((group, index) => group.status === 'final' && (includeOpen || index < groups.length - 1 || group.isSentenceBoundary))
}
export const captionGroupSignature = (group: LiveCaptionGroup): string => JSON.stringify(group.members.map(entry => [entry.id, entry.startMs, entry.endMs, entry.sourceText]))
export const freezeCaptionGroups = (entries: TranscriptEvent[], includeOpen = false): TranscriptEvent[] => {
  const ids = new Map<string, string>()
  for (const group of completedCaptionGroups(entries, includeOpen)) for (const member of group.members) ids.set(member.id, group.captionGroupId ?? group.id)
  let changed = false
  const next = entries.map(entry => {
    const id = ids.get(entry.id)
    if (!id || entry.captionGroupId === id) return entry
    changed = true; return { ...entry, captionGroupId: id }
  })
  return changed ? next : entries
}
