export type AuthUser = { id: string; username: string; NT: string; Department: string; role: 'admin' | 'user'; createdAt: string }
type AuthResult = { user: AuthUser; token?: string }

const tokenKey = 's2t-ui.auth-token.v1'
const token = (): string => window.localStorage.getItem(tokenKey) ?? ''
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
  const response = await fetch(await gatewayPath(path), { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload as T
}
const save = async (result: AuthResult): Promise<AuthUser> => {
  if (result.token) window.localStorage.setItem(tokenKey, result.token)
  await synchronizeDesktopSession()
  return result.user
}
export const authFetch = async (path: string, init: RequestInit = {}): Promise<Response> => fetch(await gatewayPath(path), { ...init, headers: { ...(init.headers ?? {}), ...(token() ? { authorization: `Bearer ${token()}` } : {}) } })

export const authClient = {
  async register(input: { username: string; password: string; NT: string; Department: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/register', input)) },
  async login(input: { username: string; password: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/login', input)) },
  async session(): Promise<AuthUser | null> { if (!token()) return null; try { const user = (await request<{ user: AuthUser }>('/api/auth/session')).user; await synchronizeDesktopSession(); return user } catch { window.localStorage.removeItem(tokenKey); await window.s2t?.clearGatewaySession(); return null } },
  async logout(): Promise<void> { try { if (token()) await request('/api/auth/logout', {}) } finally { window.localStorage.removeItem(tokenKey); await window.s2t?.clearGatewaySession() } }
}
