import type { TranscriptEvent } from './transcript'
import type { ModelProfile, ModelCapabilities } from './models'

/** An immutable audio asset retained for a session. The active version is used for playback and export. */
/** Audio and its matching caption snapshot are selected as one version. */
export type AudioVersion = { id: string; audioKey: string; createdAt: string; label: string; parentId?: string; replacedSegmentId?: string; nativeAudioPath?: string; segments?: TranscriptEvent[]; transcript?: string; modelSnapshot?: CaptureModelSnapshot }

/** Configuration actually used to create an audio version.  It is retained so
 * diagnostics and later exports do not depend on a model registry that may
 * have been edited after capture started. */
export type CaptureModelSnapshot = {
  id: string
  name: string
  endpoint: string
  model: string
  kind: ModelProfile['kind']
  requiresApiKey: boolean
  capabilities: ModelCapabilities
  sourceLanguage: string
  prompt: string
  inputSampleRate: number
  modelSampleRate: number
}

export type SavedSession = {
  id: string
  title: string
  createdAt: string
  durationMs: number
  source: string
  /** Model configuration used for the active/latest audio version. */
  modelSnapshot?: CaptureModelSnapshot
  transcript: string
  audioKey: string
  /** Old sessions without this field use audioKey as their single original version. */
  audioVersions?: AudioVersion[]
  activeAudioVersionId?: string
  nativeAudioPath?: string
  savedToDisk?: boolean
  /** The transcript is retained, but no in-app audio copy could be saved. */
  audioUnavailable?: boolean
  segments: TranscriptEvent[]
  /** Missing state on older records means completed. */
  processingState?: 'running' | 'completed' | 'failed'
  processingStage?: 'asr' | 'translation' | 'saving' | 'diarization'
  recoveryFullAsr?: boolean
  processingFailures?: Array<NonNullable<SavedSession['processingStage']>>
  processingToken?: string
  processingError?: string
  diarizationJobId?: string
  qualityCorrectionState?: 'completed' | 'failed'
  qualityCorrectionError?: string
  summary?: string
  summaryError?: string
  /** Deterministic signature of the transcript used when this summary was generated. */
  summarySourceSignature?: string
  /** Audio/caption version whose transcript was used to create the summary. */
  summarySourceVersionId?: string
  /** Standalone translation of the current summary; cleared whenever the summary is regenerated. */
  summaryTranslation?: string
  summaryTranslationTargetLanguage?: string
}

/** Account-scoped, in-progress Web capture metadata used after a forced close. */
export type LiveTranscriptDraft = {
  id: string
  startedAt: string
  updatedAt: string
  captureState: 'recording' | 'paused'
  source: string
  elapsedMs: number
  segments: TranscriptEvent[]
  opfsRecordingId?: string
  sampleRate?: number
}

/** Account-scoped progress for a chunked PCM WAV import. The file itself is
 * deliberately never copied: the user reselects the matching source file. */
export type ImportCheckpoint = {
  fingerprint: string
  modelId: string
  modelSnapshot: string
  sourceLanguage: string
  prompt: string
  nextChunkIndex: number
  nextByteOffset: number
  totalChunks: number
  segments: TranscriptEvent[]
  mergedText: string
  updatedAt: string
}

