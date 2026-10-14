import { activeTranslate } from '../i18n'

let accessToken = ''
let authenticatedUserId: string | null = null
let epoch = 0
export const requestEpoch = (): number => epoch
export const setAuthenticatedUser = (userId: string | null): void => { if (authenticatedUserId !== userId) { authenticatedUserId = userId; epoch += 1 } }
export const token = (): string => accessToken
let gatewayUrlPromise: Promise<string> | undefined
export const gatewayPath = async (path: string): Promise<string> => {
  if (!window.s2t) return path
  gatewayUrlPromise ??= window.s2t.getGatewayUrl()
  const gateway = await gatewayUrlPromise
  return gateway ? new URL(path, `${gateway}/`).toString() : path
}

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
      const response = await authFetch(path, init)
      if (![502, 503, 504].includes(response.status) || attempt === attempts - 1) return response
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
export const getGatewayUrl = async (): Promise<string> => { gatewayUrlPromise ??= window.s2t?.getGatewayUrl() ?? Promise.resolve(''); return gatewayUrlPromise }
