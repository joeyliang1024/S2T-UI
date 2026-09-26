import { type TranscriptEvent } from '../features/models/model-adapter'
import { type VadConfig } from '../features/capture/vad'

export type CaptureState = 'starting' | 'idle' | 'recording' | 'paused' | 'saving'

export type AudioDevice = { deviceId: string; label: string }

export type View = 'live' | 'history' | 'summary' | 'import' | 'models' | 'voiceprints' | 'settings'

export type SummaryTemplate = { id: string; name: string; content: string }

/** An immutable audio asset retained for a session. The active version is used for playback and export. */
export type AudioVersion = { id: string; audioKey: string; createdAt: string; label: string; parentId?: string; replacedSegmentId?: string }

export type SavedSession = {
  id: string
  title: string
  createdAt: string
  durationMs: number
  source: string
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
  summary?: string
  /** Deterministic signature of the transcript used when this summary was generated. */
  summarySourceSignature?: string
}

export type Settings = {
  theme: 'system' | 'light' | 'dark'
  uiLanguage: 'zh-TW' | 'zh-CN' | 'en' | 'ja' | 'de'
  /** Electron writes the selected destination by default; reads always merge both. */
  storageLocation: 'local' | 'remote'
  sourceLanguage: string
  targetLanguage: string
  translationEnabled: boolean
  translationStrategy: 'realtime' | 'sentence'
  translationLoadStrategy: 'automatic' | 'manual'
  modelProfiles: ModelProfile[]
  selectedModelId: string
  translationEndpoint: string
  translationModel: string
  translationProfiles: TextModelProfile[]
  selectedTranslationModelId: string
  summaryEndpoint: string
  summaryModel: string
  summaryTemplate: string
  summaryTemplates: SummaryTemplate[]
  selectedSummaryTemplateId: string
  summaryOutputLanguage: string
  summaryIncludeTranslation: boolean
  diarizationEndpoint: string
  diarizationModel: string
  glossary: string
  denoiseEnabled: boolean
  vadConfig: VadConfig
}

export type ModelCapabilities = { asrMode: 'streaming' | 'non-streaming'; vadSource: 'app' | 'server'; timestampPrecision: 'chunk' | 'segment' | 'word'; supportedLanguages?: string[]; supportedSampleRates?: number[] }

export type ModelProfile = { id: string; name: string; endpoint: string; model: string; kind: 'websocket' | 'openai-http'; /** A service explicitly configured as unauthenticated. */ requiresApiKey?: boolean; capabilities: ModelCapabilities }

export type TextModelProfile = { id: string; name: string; endpoint: string; model: string }
