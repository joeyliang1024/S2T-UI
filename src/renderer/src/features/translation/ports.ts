import type { CaptionServerTiming } from '../../shared/services/caption-metrics'
export type TextModelBinding = { id: string; endpoint: string; model: string; requiresApiKey?: boolean }
export type TranslationRequest = { workload?: 'realtime' | 'background'; text: string; sourceLanguage: string; targetLanguage: string; glossary: string; format?: 'text' | 'markdown'; temperature?: number; timeoutMs?: number; signal?: AbortSignal }
export interface TextCompletionPort { complete(input: TranslationRequest): Promise<{ text: string; server?: CaptionServerTiming }> }
