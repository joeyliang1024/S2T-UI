export type AuthUser = { id: string; username: string; NT: string; Department: string; role: 'admin' | 'user'; createdAt: string }
type AuthResult = { user: AuthUser; token?: string }

const tokenKey = 's2t-ui.auth-token.v1'
const token = (): string => window.localStorage.getItem(tokenKey) ?? ''
const request = async <T,>(path: string, input?: unknown): Promise<T> => {
  const response = await fetch(path, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload as T
}
const save = (result: AuthResult): AuthUser => { if (result.token) window.localStorage.setItem(tokenKey, result.token); return result.user }
export const authFetch = (path: string, init: RequestInit = {}): Promise<Response> => fetch(path, { ...init, headers: { ...(init.headers ?? {}), ...(token() ? { authorization: `Bearer ${token()}` } : {}) } })

export const authClient = {
  async register(input: { username: string; password: string; NT: string; Department: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/register', input)) },
  async login(input: { username: string; password: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/login', input)) },
  async session(): Promise<AuthUser | null> { if (!token()) return null; try { return (await request<{ user: AuthUser }>('/api/auth/session')).user } catch { window.localStorage.removeItem(tokenKey); return null } },
  async logout(): Promise<void> { try { if (token()) await request('/api/auth/logout', {}) } finally { window.localStorage.removeItem(tokenKey) } }
}
