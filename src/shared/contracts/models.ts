export type ModelCapabilities = { asrMode: 'streaming' | 'non-streaming'; vadSource: 'app' | 'server'; timestampPrecision: 'chunk' | 'segment' | 'word'; supportedLanguages?: string[]; supportedSampleRates?: number[] }

export type ModelProfile = { id: string; name: string; endpoint: string; model: string; kind: 'websocket' | 'openai-http'; /** A service explicitly configured as unauthenticated. */ requiresApiKey?: boolean; capabilities: ModelCapabilities }

export type TextModelProfile = { id: string; name: string; endpoint: string; model: string; requiresApiKey?: boolean }
