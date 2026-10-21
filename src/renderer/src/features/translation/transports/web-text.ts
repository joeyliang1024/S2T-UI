import type { TextModelBinding, TextCompletionPort } from '../ports'
import { authFetch, requestEpoch } from '../../../shared/http/authenticated-client'
import { activeTranslate } from '../../../shared/i18n'
import { isRequestAborted, readJsonResponse } from '../../../shared/services/http'
import { parseServerTiming } from '../../../shared/services/caption-metrics'
export const createWebTextPort = (profile: TextModelBinding, { fetch = authFetch, clock = window }: { fetch?: typeof authFetch; clock?: Pick<Window, 'setTimeout' | 'clearTimeout'> } = {}): TextCompletionPort => {
  profile = { ...profile }
  const owner = requestEpoch()
  const checkOwner = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  return { complete: async input => {
    checkOwner()
    if (input.signal?.aborted) throw new DOMException('Translation canceled', 'AbortError')
    const controller = new AbortController(), cancel = (): void => controller.abort()
    input.signal?.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timeout = clock.setTimeout(() => { timedOut = true; controller.abort() }, input.timeoutMs ?? (input.workload !== 'realtime' || input.format === 'markdown' ? 90_000 : 15_000))
    try {
      const response = await fetch('/api/translations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-s2t-workload': input.workload || 'background', 'x-s2t-idempotency-key': crypto.randomUUID(), ...(!['none','web-environment-translation'].includes(profile.id) ? { 'x-s2t-model-id': profile.id } : {}) }, body: JSON.stringify({ text: input.text, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, glossary: input.glossary, temperature: input.temperature, ...(input.format === 'markdown' ? { format: 'markdown' } : {}) }), signal: controller.signal })
      const result = await readJsonResponse<{ text: string }>(response, activeTranslate(input.format === 'markdown' ? 'stSummaryTranslationService' : 'stWebTranslationGateway'))
      checkOwner()
      if (controller.signal.aborted) throw new DOMException('Translation canceled', 'AbortError')
      return { text: result.text, server: parseServerTiming(response.headers.get('server-timing')) }
    } catch (error) {
      checkOwner()
      if (input.signal?.aborted) throw new DOMException('Translation canceled', 'AbortError')
      if (timedOut || isRequestAborted(error)) throw new Error(activeTranslate(input.format === 'markdown' ? 'stSummaryTranslationTimeout' : 'svcTranslationTimeout'))
      throw error
    } finally { clock.clearTimeout(timeout); input.signal?.removeEventListener('abort', cancel) }
  } }
}
