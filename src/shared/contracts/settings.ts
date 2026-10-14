import type { ModelProfile, TextModelProfile } from './models'
import type { ResponseSpeed } from './response-speed'
export type SummaryTemplate = { id: string; name: string; content: string; sourceFile?: string }

export type Settings = {
  adminParameters?: import("../validation/admin-parameters.cjs").AdminParameters
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
  diarizationProfiles?: TextModelProfile[]
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

