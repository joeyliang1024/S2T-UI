import { activeTranslate } from '../../../shared/i18n'

export type AuthUser = { id: string; username: string; NT: string; Department: string; role: 'admin' | 'user'; createdAt: string }
type AuthResult = { user: AuthUser; token?: string }

// The Web gateway issues an HttpOnly cookie. Keep a token only in renderer
// memory for the Electron main-process bridge; never persist it in browser
// localStorage where recordings/settings must not live either.
let accessToken = ''
const token = (): string => accessToken
let gatewayUrlPromise: Promise<string> | undefined
const gatewayPath = async (path: string): Promise<string> => {
  if (!window.s2t) return path
  gatewayUrlPromise ??= window.s2t.getGatewayUrl()
  const gateway = await gatewayUrlPromise
  return gateway ? new URL(path, `${gateway}/`).toString() : path
}
const synchronizeDesktopSession = async (): Promise<void> => {
  const accessToken = token()
  if (!window.s2t || !accessToken) return
  gatewayUrlPromise ??= window.s2t.getGatewayUrl()
  // A development renderer may use Vite's relative /api proxy. The main
  // process cannot validate a relative URL, so only synchronize when an
  // explicit external (or explicitly configured local-test) gateway exists.
  if (await gatewayUrlPromise) await window.s2t.authenticateGatewaySession(accessToken)
}
const request = async <T,>(path: string, input?: unknown): Promise<T> => {
  const response = await fetch(await gatewayPath(path), { credentials: 'include', method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload as T
}
const save = async (result: AuthResult): Promise<AuthUser> => {
  if (result.token) accessToken = result.token
  await synchronizeDesktopSession()
  return result.user
}
export const authFetch = async (path: string, init: RequestInit = {}): Promise<Response> => fetch(await gatewayPath(path), { ...init, credentials: 'include', headers: { ...(init.headers ?? {}), ...(token() ? { authorization: `Bearer ${token()}` } : {}) } })

// Gateway requests carry no Pod-local state. A connection reset during a
// rolling update can therefore be retried safely by callers whose operation
// is idempotent (object key writes, CAS saves, reads and deletes).
export const retryableAuthFetch = async (path: string, init: RequestInit = {}, attempts = 3): Promise<Response> => {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
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

export const authClient = {
  async register(input: { username: string; password: string; NT: string; Department: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/register', input)) },
  async login(input: { username: string; password: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/login', input)) },
  async session(): Promise<AuthUser | null> { try { const user = (await request<{ user: AuthUser }>('/api/auth/session')).user; await synchronizeDesktopSession(); return user } catch { accessToken = ''; await window.s2t?.clearGatewaySession(); return null } },
  async logout(): Promise<void> { try { await request('/api/auth/logout', {}) } finally { accessToken = ''; await window.s2t?.clearGatewaySession() } }
}
