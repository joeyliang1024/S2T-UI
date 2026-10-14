export type TranscriptEvent = {
  id: string
  revision: number
  asrRevision?: number
  /** Stable display row, locked before speaker identification. */
  captionGroupId?: string
  status: 'partial' | 'final' | 'gap'
  startMs: number
  endMs: number
  correctionOriginalText?: string
  sourceText: string
  translatedText?: string
  speaker?: string
  /** User-provided speaker names are authoritative over later diarization passes. */
  speakerManuallyEdited?: boolean
  translationStatus?: 'failed' | 'completed'
  /** Failed automatic translation attempts for this exact caption revision. */
  translationAttempts?: number
  /** Changes only when translation input or a manual translation changes. */
  translationContentRevision?: number
  /** True only when app-side VAD observed a natural silence boundary. HTTP
   * chunks sent while speech continues deliberately keep this false so the UI
   * can extend one readable caption instead of making a new row. */
  isSentenceBoundary?: boolean
  /** Updates only closure metadata; never replaces a manually edited caption. */
  boundaryOnly?: boolean
  /** Best-effort app-side source language when ASR runs in automatic mode. */
  detectedLanguage?: 'zh-TW' | 'en-US' | 'ja-JP' | 'de-DE'
  /** Present only when audio could not be transcribed. Export this event so a
   * reviewer can distinguish an ASR failure from a genuine silent interval. */
  gapReason?: 'queue-overflow' | 'request-failed'
}

