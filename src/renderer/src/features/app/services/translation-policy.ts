import type { TranscriptEvent } from '../../models/model-adapter'

export const translationAggregationDelayMs = 220
export const maximumSentenceWaitMs = 5_000

export const canMergeHttpCaption = (previous: TranscriptEvent | undefined, next: TranscriptEvent, clearedThroughMs: number): boolean =>
  Boolean(next.id.startsWith('http-') && previous?.id.startsWith('http-') &&
  previous.status === 'final' && next.status === 'final' &&
  previous.endMs > clearedThroughMs && !previous.isSentenceBoundary &&
  next.startMs - previous.endMs < 900 && next.endMs - previous.startMs < 12_000)

export const shouldAutoTranslate = (entry: TranscriptEvent, strategy: 'realtime' | 'sentence', elapsedMs: number): boolean => {
  if (entry.status !== 'final' || !entry.sourceText.trim() || entry.translatedText || entry.translationStatus) return false
  if (strategy === 'realtime') return true
  return Boolean(entry.isSentenceBoundary || /[。！？.!?]$/.test(entry.sourceText.trim()) || elapsedMs - entry.endMs >= maximumSentenceWaitMs)
}
