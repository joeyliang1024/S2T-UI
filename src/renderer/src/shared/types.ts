import { type TranscriptEvent } from '../features/models/model-adapter'
import { type ResponseSpeed } from '../features/capture/vad'

export type CaptureState = 'starting' | 'idle' | 'recording' | 'paused' | 'saving'

export type AudioDevice = { deviceId: string; label: string }

export type View = 'live' | 'history' | 'summary' | 'import' | 'models' | 'voiceprints' | 'settings'

export type SummaryTemplate = { id: string; name: string; content: string }

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
  processingToken?: string
  processingError?: string
  diarizationJobId?: string
  qualityCorrectionState?: 'completed' | 'failed'
  qualityCorrectionError?: string
  summary?: string
  /** Deterministic signature of the transcript used when this summary was generated. */
  summarySourceSignature?: string
  /** Audio/caption version whose transcript was used to create the summary. */
  summarySourceVersionId?: string
  /** Standalone translation of the current summary; cleared whenever the summary is regenerated. */
  summaryTranslation?: string
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

export type Settings = {
  theme: 'system' | 'light' | 'dark'
  uiLanguage: 'zh-TW' | 'zh-CN' | 'en' | 'ja' | 'de' | 'system'
  /** Electron writes the selected destination by default; reads always merge both. */
  storageLocation: 'local' | 'remote'
  sourceLanguage: string
  /** auto chooses English for Chinese and Traditional Chinese for other supported inputs. */
  targetLanguage: string
  translationEnabled: boolean
  translationStrategy: 'realtime' | 'sentence'
  translationLoadStrategy: 'automatic' | 'throttled' | 'manual'
  modelProfiles: ModelProfile[]
  selectedModelId: string
  translationEndpoint: string
  translationModel: string
  translationProfiles: TextModelProfile[]
  selectedTranslationModelId: string
  summaryEndpoint: string
  summaryModel: string
  summaryRequiresApiKey: boolean
  summaryTemplate: string
  summaryTemplates: SummaryTemplate[]
  selectedSummaryTemplateId: string
  summaryOutputLanguage: string
  summaryIncludeTranslation: boolean
  diarizationEndpoint: string
  diarizationModel: string
  diarizationRequiresApiKey: boolean
  /** The embedding service is separate from speaker diarization. */
  embeddingEndpoint: string
  embeddingModel: string
  embeddingRequiresApiKey: boolean
  diarizationPreviewEnabled: boolean
  glossary: string
  denoiseEnabled: boolean
  /** Higher quality anti-alias window for the ASR-only resample branch. */
  kaiserResampleEnabled: boolean
  /** Uses the gateway's worker-hosted Silero model to reject non-speech ASR chunks. */
  sileroVadEnabled: boolean
  dynaudnormEnabled: boolean
  responseSpeed: ResponseSpeed
}

export type ModelCapabilities = { asrMode: 'streaming' | 'non-streaming'; vadSource: 'app' | 'server'; timestampPrecision: 'chunk' | 'segment' | 'word'; supportedLanguages?: string[]; supportedSampleRates?: number[] }

export type ModelProfile = { id: string; name: string; endpoint: string; model: string; kind: 'websocket' | 'openai-http'; /** A service explicitly configured as unauthenticated. */ requiresApiKey?: boolean; capabilities: ModelCapabilities }

export type TextModelProfile = { id: string; name: string; endpoint: string; model: string; requiresApiKey?: boolean }
