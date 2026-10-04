import type { TranscriptEvent } from '../../models/model-adapter'

export const translationAggregationDelayMs = 220
export const throttledTranslationDelayMs = 900
// External translation calls are independent work. Keep a small concurrent
// ceiling instead of serializing every caption behind one slow request.
export const maximumAutomaticTranslationQueue = 2
export const maximumSentenceWaitMs = 5_000

export type TranslationSourceLanguage = NonNullable<TranscriptEvent['detectedLanguage']>

/**
 * "Auto" keeps the bilingual live-caption flow useful without guessing a
 * third language: Chinese is translated to English, all other supported
 * inputs are translated to Traditional Chinese.
 */
export const resolveTranslationTarget = (source: TranslationSourceLanguage | undefined, configuredTarget: string): string => {
  if (configuredTarget !== 'auto') return configuredTarget
  return source === 'zh-TW' ? 'en' : 'zh-TW'
}

export const shouldSkipTranslation = (source: TranslationSourceLanguage | undefined, target: string): boolean =>
  Boolean(source && (source === target || (source === 'en-US' && target === 'en') || (source === 'ja-JP' && target === 'ja') || (source === 'de-DE' && target === 'de')))

export const canMergeHttpCaption = (previous: TranscriptEvent | undefined, next: TranscriptEvent, clearedThroughMs: number, previousIsTranslating = false): boolean =>
  Boolean(next.id.startsWith('http-') && previous?.id.startsWith('http-') &&
  previous.status === 'final' && next.status === 'final' &&
  // Never replace a completed translation with a longer, untranslated merge.
  // Continuing speech will start a new caption which can be translated on its
  // own, so bilingual output remains stable during long utterances.
  !previousIsTranslating && !previous.translatedText && !previous.translationStatus &&
  previous.endMs > clearedThroughMs && !previous.isSentenceBoundary &&
  next.startMs - previous.endMs < 900 && next.endMs - previous.startMs < 12_000)

export const shouldAutoTranslate = (entry: TranscriptEvent, strategy: 'realtime' | 'sentence', elapsedMs: number): boolean => {
  if (entry.status !== 'final' || !entry.sourceText.trim() || entry.translatedText || entry.translationStatus) return false
  if (strategy === 'realtime') return true
  return Boolean(entry.isSentenceBoundary || /[。！？.!?]$/.test(entry.sourceText.trim()) || elapsedMs - entry.endMs >= maximumSentenceWaitMs)
}
