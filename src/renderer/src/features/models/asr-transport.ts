import type { TranscriptEvent } from '../../../../shared/contracts/transcript'
import type { CaptionServerTiming } from '../../shared/services/caption-metrics'

export type AsrRequest = { audio: ArrayBuffer; key: string; language: string; prompt?: string; signal?: AbortSignal }
export type AsrResult = { text: string; detectedLanguage?: TranscriptEvent['detectedLanguage']; server?: CaptionServerTiming }
export type AsrProfile = { id: string; endpoint: string; model: string; requiresApiKey?: boolean; gatewayProfileId?: string; dynaudnormEnabled?: boolean }
/** One transport is bound to a model profile and an account for its entire capture. */
export interface AsrTransport {
  readonly cancellation: 'request' | 'result'

  ensureReady(): Promise<void>
  transcribe(request: AsrRequest): Promise<AsrResult>
  hasSpeech(audio: ArrayBuffer): Promise<boolean>
}
