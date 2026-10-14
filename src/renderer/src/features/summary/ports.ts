export type SummaryMessage = { role: 'system' | 'user'; content: string }
export type SummaryRequest = { messages: SummaryMessage[]; singleAttempt?: boolean; onText?: (text: string) => void; signal?: AbortSignal }
export type SummaryProfile = { endpoint: string; model: string; requiresApiKey?: boolean }
/** Completion and streaming share one deadline and one account-bound lifecycle. */
export interface SummaryStreamPort {
  complete(input: SummaryRequest): Promise<{ text: string }>
}
