import type { ReactElement } from 'react'
import type { AuthUser } from '../auth/services/auth-client'
import { useAppController } from './hooks/useAppController'
import { AppView } from './views/AppView'

export default function AuthenticatedApp({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }): ReactElement {
  const controller = useAppController(user.id, user.role)
  return <AppView controller={controller} user={user} onLogout={onLogout} />
}
