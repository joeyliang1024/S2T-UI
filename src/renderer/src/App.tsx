import { lazy, Suspense, type ReactElement } from 'react'
import { useAuth } from './features/auth/hooks/useAuth'
import { AuthGate } from './features/auth/views/AuthGate'
import { authTranslate, resolveUiLanguage } from './shared/i18n'

const AuthenticatedApp = lazy(() => import('./features/app/AuthenticatedApp'))

export default function App(): ReactElement {
  const auth = useAuth()
  if (auth.status !== 'signed-in' || !auth.user) return <AuthGate auth={auth} />
  return <Suspense fallback={<main className="auth-screen"><p role="status">{authTranslate(resolveUiLanguage('system'), 'checking')}</p></main>}>
    <AuthenticatedApp key={auth.user.id} user={auth.user} onLogout={auth.logout} />
  </Suspense>
}
