import type { SummaryProfile, SummaryRequest, SummaryStreamPort } from '../ports'
import { authFetch, requestEpoch } from '../../../shared/http/authenticated-client'
import { activeTranslate } from '../../../shared/i18n'
import { isRequestAborted, readJsonResponse } from '../../../shared/services/http'
import { readSummaryStream } from '../services/stream'

type Dependencies = { fetch?: typeof authFetch; readStream?: typeof readSummaryStream; clock?: Pick<Window, 'setTimeout' | 'clearTimeout'> }
export const createWebSummaryPort = (profile: SummaryProfile, { fetch = authFetch, readStream = readSummaryStream, clock = window }: Dependencies = {}): SummaryStreamPort => {
  profile = { ...profile }
  const owner = requestEpoch()
  const checkOwner = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  return { complete: async (input: SummaryRequest) => {
    checkOwner()
    if (input.signal?.aborted) throw new DOMException('Summary canceled', 'AbortError')
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    input.signal?.addEventListener('abort', cancel, { once: true })
    let timedOut = false
    const timeout = clock.setTimeout(() => { timedOut = true; controller.abort() }, 90_000)
    const check = (): void => { checkOwner(); if (controller.signal.aborted) throw new DOMException('Summary canceled', 'AbortError') }
    try {
      const response = await fetch('/api/summaries', { method: 'POST', headers: { 'content-type': 'application/json', ...(profile.endpoint && profile.endpoint !== '/api/summaries' ? { 'x-s2t-model-id': 'managed-summary' } : {}) }, body: JSON.stringify({ messages: input.messages, singleAttempt: input.singleAttempt ?? false, stream: Boolean(input.onText) }), signal: controller.signal })
      check()
      const result = response.headers.get('content-type')?.includes('application/x-ndjson')
        ? await readStream(response, text => { check(); input.onText?.(text) })
        : await readJsonResponse<{ text: string }>(response, activeTranslate('stSummaryService'))
      check()
      return result
    } catch (error) {
      checkOwner()
      if (input.signal?.aborted) throw new DOMException('Summary canceled', 'AbortError')
      if (timedOut || isRequestAborted(error)) throw new Error(activeTranslate('stSummaryServiceTimeout'))
      throw error
    } finally { clock.clearTimeout(timeout); input.signal?.removeEventListener('abort', cancel) }
  } }
}
