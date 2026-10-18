import type { DesktopBridge } from '../../../../../shared/contracts/desktop'
import type { TextModelBinding, TextCompletionPort } from '../ports'
import { requestEpoch } from '../../../shared/http/authenticated-client'
import { activeTranslate } from '../../../shared/i18n'
import { textEndpoint } from '../../../shared/services/settings'
import { isRequestAborted } from '../../../shared/services/http'
import { translationMessages } from '../domain/messages'
export const createDesktopTextPort = (profile: TextModelBinding, bridge: Pick<DesktopBridge, 'completeText' | 'cancelCompleteText'>, clock: Pick<Window, 'setTimeout' | 'clearTimeout'> = window): TextCompletionPort => {
  profile = { ...profile }
  const owner = requestEpoch()
  const checkOwner = (): void => { if (owner !== requestEpoch()) throw new DOMException('Account changed', 'AbortError') }
  return { complete: async input => {
    checkOwner()
    if (input.signal?.aborted) throw new DOMException('Translation canceled', 'AbortError')
    const requestId = `translation-${crypto.randomUUID()}`
    let rejectCanceled: (error: Error) => void = () => {}, timedOut = false
    const canceled = new Promise<never>((_resolve, reject) => { rejectCanceled = reject })
    const timeoutError = (): Error => new Error(activeTranslate(input.format === 'markdown' ? 'stSummaryTranslationTimeout' : 'svcTranslationTimeout'))
    const cancelIpc = (): void => { void Promise.resolve().then(() => bridge.cancelCompleteText(requestId)).catch(() => undefined) }
    const cancel = (): void => { rejectCanceled(new DOMException('Translation canceled', 'AbortError')); cancelIpc() }
    input.signal?.addEventListener('abort', cancel, { once: true })
    const timeout = clock.setTimeout(() => { timedOut = true; rejectCanceled(timeoutError()); cancelIpc() }, input.timeoutMs ?? (input.format === 'markdown' ? 90_000 : 15_000))
    try {
      const result = await Promise.race([bridge.completeText({ requestId, profileId: profile.id === 'none' ? 'translation' : profile.id, endpoint: textEndpoint(profile.endpoint), model: profile.model, requiresApiKey: profile.requiresApiKey, temperature: input.temperature, messages: translationMessages(input) }), canceled])
      checkOwner()
      if (input.signal?.aborted) throw new DOMException('Translation canceled', 'AbortError')
      return result
    } catch (error) {
      checkOwner()
      if (input.signal?.aborted) throw new DOMException('Translation canceled', 'AbortError')
      if (timedOut || isRequestAborted(error)) throw timeoutError()
      throw error
    } finally { clock.clearTimeout(timeout); input.signal?.removeEventListener('abort', cancel) }
  } }
}
