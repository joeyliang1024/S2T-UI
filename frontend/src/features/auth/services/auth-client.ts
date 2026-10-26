
export type AuthUser = { id: string; username: string; NT: string; Department: string; role: 'admin' | 'developer' | 'user'; createdAt: string }
type AuthResult = { user: AuthUser; token?: string }

// Authentication uses an HttpOnly cookie; tokens stay in memory only.
import { token, gatewayPath, setAccessToken, setAuthenticatedUser } from '../../../shared/http/authenticated-client'
export { authFetch, retryableAuthFetch } from '../../../shared/http/authenticated-client'

const request = async <T,>(path: string, input?: unknown): Promise<T> => {
  const response = await fetch(await gatewayPath(path), { credentials: 'include', method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token() ? { authorization: `Bearer ${token()}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status })
  return payload as T
}
const save = async (result: AuthResult): Promise<AuthUser> => {
  if (result.token) setAccessToken(result.token)
  setAuthenticatedUser(result.user.id)
  return result.user
}
export const authClient = {
  async register(input: { password: string; NT: string; Department: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/register', input)) },
  async login(input: { NT: string; password: string }): Promise<AuthUser> { return save(await request<AuthResult>('/api/auth/login', input)) },
  async session(): Promise<AuthUser | null> { try { const user = (await request<{ user: AuthUser }>('/api/auth/session')).user; setAuthenticatedUser(user.id); return user } catch (error) { if ((error as { status?: number }).status === 401) { setAccessToken(''); setAuthenticatedUser(null); return null } throw error } },
  async logout(): Promise<void> { await request('/api/auth/logout', {}); setAccessToken(''); setAuthenticatedUser(null); await undefined }
}
