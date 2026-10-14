import type { DesktopBridge } from '../../../../../shared/contracts/desktop'
import type { SummaryProfile, SummaryStreamPort } from '../ports'
import { requestEpoch } from '../../../shared/http/authenticated-client'
import { activeTranslate } from '../../../shared/i18n'
import { textEndpoint } from '../../../shared/services/settings'

export const createDesktopSummaryPort = (profile: SummaryProfile, bridge: Pick<DesktopBridge, 'completeText' | 'cancelCompleteText'>, clock: Pick<Window, 'setTimeout' | 'clearTimeout'> = window): SummaryStreamPort => {
  profile = { ...profile }
  const owner = requestEpoch()
  const checkOwner = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  return { complete: async input => {
    checkOwner()
    if (input.signal?.aborted) throw new DOMException('Summary canceled', 'AbortError')
    const requestId = `summary-${crypto.randomUUID()}`
    let rejectCanceled: (error: Error) => void = () => {}
    const canceled = new Promise<never>((_resolve, reject) => { rejectCanceled = reject })
    const cancel = (): void => {
      rejectCanceled(new DOMException('Summary canceled', 'AbortError'))
      void Promise.resolve().then(() => bridge.cancelCompleteText(requestId)).catch(() => undefined)
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    const timeout = clock.setTimeout(() => {
      rejectCanceled(new Error(activeTranslate('stSummaryServiceTimeout')))
      void Promise.resolve().then(() => bridge.cancelCompleteText(requestId)).catch(() => undefined)
    }, 90_000)
    try {
      const result = await Promise.race([bridge.completeText({ requestId, profileId: 'summary', endpoint: textEndpoint(profile.endpoint), model: profile.model, requiresApiKey: profile.requiresApiKey, messages: input.messages }), canceled])
      checkOwner()
      if (input.signal?.aborted) throw new DOMException('Summary canceled', 'AbortError')
      return result
    } finally { clock.clearTimeout(timeout); input.signal?.removeEventListener('abort', cancel) }
  } }
}
