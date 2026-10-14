import type { AsrProfile, AsrRequest, AsrResult, AsrTransport } from '../asr-transport'
import { activeTranslate } from '../../../shared/i18n'
import { parseServerTiming } from '../../../shared/services/caption-metrics'
import { readJsonResponse } from '../../../shared/services/http'
import { authFetch, requestEpoch } from '../../../shared/http/authenticated-client'

const readGatewayPayload = async (response: Response): Promise<{ text?: string; error?: string; detectedLanguage?: string }> => {
  const body = await response.text()
  if (!body.trim()) throw new Error(activeTranslate('svcHttpNoBody').replace('{service}', 'Web ASR gateway').replace('{status}', String(response.status)))
  try { return JSON.parse(body) as { text?: string; error?: string } } catch { throw new Error(activeTranslate('svcHttpNonJson').replace('{service}', 'Web ASR gateway').replace('{status}', String(response.status))) }
}

export const createWebAsrTransport = (profile: AsrProfile, fetch: typeof authFetch = authFetch): AsrTransport => {
  profile = { ...profile }
  const ownerEpoch = requestEpoch()
  const checkOwner = (): void => { if (ownerEpoch !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  const transcribe = async (request: AsrRequest): Promise<AsrResult> => {
    checkOwner()
    if (request.signal?.aborted) throw new DOMException('ASR canceled', 'AbortError')
    const { audio, prompt } = request
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    request.signal?.addEventListener('abort', cancel, { once: true })
    if (request.signal?.aborted) controller.abort()
    let timedOut = false
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, 30_000)
    try {
      const response = await fetch('/api/transcriptions', {
        method: 'POST', headers: {
          'content-type': 'audio/wav', 'x-s2t-idempotency-key': request.key, 'x-s2t-language': request.language,
          ...(profile.gatewayProfileId ? { 'x-s2t-model-id': profile.gatewayProfileId } : {}),
          ...(profile.dynaudnormEnabled ? { 'x-s2t-dynaudnorm': 'true' } : {}),
          ...(prompt ? { 'x-s2t-prompt': encodeURIComponent(prompt) } : {})
        }, body: audio, signal: controller.signal
      })
      const server = parseServerTiming(response.headers.get('server-timing'))
      const payload = await readJsonResponse<{ text?: string; detectedLanguage?: string }>(response, 'Web ASR gateway')
      checkOwner()
      if (controller.signal.aborted) throw new DOMException('ASR canceled', 'AbortError')
      const detectedLanguage = payload.detectedLanguage === 'zh-TW' || payload.detectedLanguage === 'en-US' || payload.detectedLanguage === 'ja-JP' || payload.detectedLanguage === 'de-DE' ? payload.detectedLanguage : undefined
      return { text: payload.text || '', detectedLanguage, ...(server ? { server } : {}) }
    } catch (error) {
      if (timedOut) { const timeoutError = new Error(activeTranslate('svcAsrRequestTimeout')); timeoutError.name = 'TimeoutError'; throw timeoutError }
      throw error
    } finally { window.clearTimeout(timeout); request.signal?.removeEventListener('abort', cancel) }
  }
  return {
    cancellation: 'request',
    ensureReady: async () => { checkOwner(); if (!profile.gatewayProfileId) throw new Error(activeTranslate('svcWebAsrModelOnly')) },
    transcribe,
    hasSpeech: async audio => {
      checkOwner()
      const response = await fetch('/api/audio-processing/silero-vad', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio })
      const payload = await readGatewayPayload(response) as { error?: string; speech?: unknown[] }
      checkOwner()
      if (!response.ok) throw new Error(payload.error || activeTranslate('svcSileroGatewayFailed').replace('{status}', String(response.status)))
      return Array.isArray(payload.speech) && payload.speech.length > 0
    }
  }
}
