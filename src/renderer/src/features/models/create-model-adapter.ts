import { OpenAiChunkedModelAdapter } from './adapters/openai-chunked'
import { createDesktopAsrTransport } from './transports/desktop-asr'
import { createWebAsrTransport } from './transports/web-asr'
import type { AsrTransport } from './asr-transport'

/** Platform selection belongs to composition, outside the queue/PCM lifecycle. */
export const createOpenAiChunkedModelAdapter = (profile: ConstructorParameters<typeof OpenAiChunkedModelAdapter>[0], transport?: AsrTransport): OpenAiChunkedModelAdapter =>
  new OpenAiChunkedModelAdapter(profile, transport ?? (window.s2t ? createDesktopAsrTransport(profile, window.s2t) : createWebAsrTransport(profile)))
