import type { ReactElement } from 'react'
import { useAppController } from './features/app/hooks/useAppController'
import { AppView } from './features/app/views/AppView'
import { useAuth } from './features/auth/hooks/useAuth'
import { AuthGate } from './features/auth/views/AuthGate'
import type { AuthUser } from './features/auth/services/auth-client'

const AuthenticatedApp = ({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }): ReactElement => {
  const controller = useAppController(user.id)
  return <AppView controller={controller} user={user} onLogout={onLogout} />
}

export default function App(): ReactElement {
  const auth = useAuth()
  return auth.status === 'signed-in' && auth.user ? <AuthenticatedApp user={auth.user} onLogout={auth.logout} /> : <AuthGate auth={auth} />
}
