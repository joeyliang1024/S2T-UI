import { type TranscriptEvent } from '../features/models/model-adapter'
import { type VadConfig } from '../features/capture/vad'

export type CaptureState = 'starting' | 'idle' | 'recording' | 'paused' | 'saving'

export type AudioDevice = { deviceId: string; label: string }

export type View = 'live' | 'history' | 'import' | 'models' | 'voiceprints' | 'settings'

export type SavedSession = {
  id: string
  title: string
  createdAt: string
  durationMs: number
  source: string
  transcript: string
  audioKey: string
  nativeAudioPath?: string
  savedToDisk?: boolean
  segments: TranscriptEvent[]
  summary?: string
}

export type Settings = {
  theme: 'system' | 'light' | 'dark'
  /** Electron writes the selected destination by default; reads always merge both. */
  storageLocation: 'local' | 'remote'
  sourceLanguage: string
  targetLanguage: string
  translationEnabled: boolean
  translationStrategy: 'realtime' | 'sentence'
  modelProfiles: ModelProfile[]
  selectedModelId: string
  translationEndpoint: string
  translationModel: string
  translationProfiles: TextModelProfile[]
  selectedTranslationModelId: string
  summaryEndpoint: string
  summaryModel: string
  summaryTemplate: string
  summaryOutputLanguage: string
  summaryIncludeTranslation: boolean
  diarizationEndpoint: string
  diarizationModel: string
  glossary: string
  denoiseEnabled: boolean
  vadConfig: VadConfig
}

export type ModelCapabilities = { asrMode: 'streaming' | 'non-streaming'; vadSource: 'app' | 'server'; timestampPrecision: 'chunk' | 'segment' | 'word' }

export type ModelProfile = { id: string; name: string; endpoint: string; model: string; kind: 'websocket' | 'openai-http'; capabilities: ModelCapabilities }

export type TextModelProfile = { id: string; name: string; endpoint: string; model: string }
