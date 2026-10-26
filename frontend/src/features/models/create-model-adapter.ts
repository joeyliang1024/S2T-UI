import { OpenAiChunkedModelAdapter } from './adapters/openai-chunked'
import { createWebAsrTransport } from './transports/web-asr'
import type { AsrTransport } from './asr-transport'

/** Platform selection belongs to composition, outside the queue/PCM lifecycle. */
export const createOpenAiChunkedModelAdapter = (profile: ConstructorParameters<typeof OpenAiChunkedModelAdapter>[0], transport?: AsrTransport): OpenAiChunkedModelAdapter =>
  new OpenAiChunkedModelAdapter(profile, transport ?? ((createWebAsrTransport(profile))))
