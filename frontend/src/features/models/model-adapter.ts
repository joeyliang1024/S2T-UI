// Compatibility exports; concrete adapter lifecycles are owned by their modules.
export type { TranscriptEvent } from '../../../shared/contracts/transcript'
export type { ModelAdapter } from './contracts'
export { sanitizeAsrText, isRepetitiveAsrText } from './domain/asr-text'
export { NoopModelAdapter } from './adapters/noop'
export { WebSocketModelAdapter } from './adapters/websocket'
export { OpenAiChunkedModelAdapter } from './adapters/openai-chunked'
export { createOpenAiChunkedModelAdapter } from './create-model-adapter'
