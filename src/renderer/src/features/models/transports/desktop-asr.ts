import type { DesktopBridge } from '../../../../../shared/contracts/desktop'
import type { AsrProfile, AsrTransport } from '../asr-transport'
import { activeTranslate } from '../../../shared/i18n'
import { requestEpoch } from '../../../shared/http/authenticated-client'

export const createDesktopAsrTransport = (profile: AsrProfile, bridge: Pick<DesktopBridge, 'hasModelApiKey' | 'transcribeAudioChunk'>): AsrTransport => {
  profile = { ...profile }
  const ownerEpoch = requestEpoch()
  const checkOwner = (): void => { if (ownerEpoch !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  return {
    // Main's ASR IPC has no cancel request ID. Reject stale results after completion.
    cancellation: 'result',
    ensureReady: async () => {
      checkOwner()
      if (profile.requiresApiKey !== false && !(await bridge.hasModelApiKey(profile.id))) throw new Error(activeTranslate('svcModelApiKeyRequired'))
      checkOwner()
    },
    transcribe: async request => {
      checkOwner()
      if (request.signal?.aborted) throw new DOMException('ASR canceled', 'AbortError')
      const result = await bridge.transcribeAudioChunk({ profileId: profile.id, endpoint: profile.endpoint, model: profile.model,
        language: request.language, requiresApiKey: profile.requiresApiKey !== false, prompt: request.prompt, audio: request.audio })
      checkOwner()
      if (request.signal?.aborted) throw new DOMException('ASR canceled', 'AbortError')
      return result
    },
    hasSpeech: async () => { throw new Error(activeTranslate('svcSileroProvidedByGateway')) }
  }
}
