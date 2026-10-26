import { activeTranslate } from '../i18n'

let accessToken = ''
let authenticatedUserId: string | null = null
let epoch = 0
export const requestEpoch = (): number => epoch
export const setAuthenticatedUser = (userId: string | null): void => { if (authenticatedUserId !== userId) { authenticatedUserId = userId; epoch += 1 } }
export const token = (): string => accessToken
export const gatewayPath = async (path: string): Promise<string> => path

export const authFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const credential = token()
  const ownerEpoch = requestEpoch()
  const url = await gatewayPath(path)
  if (credential !== token() || ownerEpoch !== requestEpoch()) throw new DOMException('Account changed', 'AbortError')
  const headers = new Headers(init.headers)
  if (credential) headers.set('authorization', `Bearer ${credential}`)
  return fetch(url, { ...init, credentials: 'include', headers })
}

// Gateway requests carry no Pod-local state. A connection reset during a
// rolling update can therefore be retried safely by callers whose operation
// is idempotent (object key writes, CAS saves, reads and deletes).
export const retryableAuthFetch = async (path: string, init: RequestInit = {}, attempts = 3): Promise<Response> => {
  const credential = token()
  const ownerEpoch = requestEpoch()
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (credential !== token() || ownerEpoch !== requestEpoch()) throw new DOMException('Account changed', 'AbortError')
      // A blackholed upload must not pin the recording writer indefinitely.
      const bodyBytes = init.body instanceof Blob ? init.body.size : init.body instanceof ArrayBuffer ? init.body.byteLength : ArrayBuffer.isView(init.body) ? init.body.byteLength : 0
      const deadline = AbortSignal.timeout(bodyBytes > 1024 ** 2 ? 120000 : 15000)
      const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
      const response = await authFetch(path, { ...init, signal })
      if (![502, 503, 504].includes(response.status) || attempt === attempts - 1) return response
      await response.body?.cancel()
      lastError = new Error(activeTranslate('svcGatewayUnavailable').replace('{status}', String(response.status)))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      lastError = error
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150 * (attempt + 1)))
  }
  throw lastError instanceof Error ? lastError : new Error(activeTranslate('svcGatewayConnectionLost'))
}


export const setAccessToken = (value: string): void => { if (accessToken !== value) { accessToken = value; epoch += 1 } }
