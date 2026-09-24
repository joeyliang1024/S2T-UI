import { useCallback, useEffect, useState } from 'react'
import { authClient, type AuthUser } from '../services/auth-client'

export type AuthState = { status: 'checking' | 'signed-out' | 'signed-in'; user: AuthUser | null; error: string }

export const useAuth = () => {
  const [state, setState] = useState<AuthState>({ status: 'checking', user: null, error: '' })
  useEffect(() => { void authClient.session().then((user) => setState({ status: user ? 'signed-in' : 'signed-out', user, error: '' })).catch(() => setState({ status: 'signed-out', user: null, error: '' })) }, [])
  const login = useCallback(async (input: { username: string; password: string }) => { const user = await authClient.login(input); setState({ status: 'signed-in', user, error: '' }) }, [])
  const register = useCallback(async (input: { username: string; password: string; NT: string; Department: string }) => { const user = await authClient.register(input); setState({ status: 'signed-in', user, error: '' }) }, [])
  const logout = useCallback(async () => { await authClient.logout(); setState({ status: 'signed-out', user: null, error: '' }) }, [])
  return { ...state, login, register, logout, setError: (error: string) => setState((current) => ({ ...current, error })) }
}
