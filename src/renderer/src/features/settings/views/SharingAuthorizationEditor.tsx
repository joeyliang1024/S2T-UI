import { useEffect, useState, type ReactElement } from 'react'
import { authFetch, type AuthUser } from '../../auth/services/auth-client'
import { interfaceTranslate } from '../../../shared/i18n/index'

export type SharingAccount = AuthUser & { deletionState?: 'deleting'; sharingAuthorization?: { approved: boolean; department: string } }
export function SharingAuthorizationEditor({ account, onSaved, ui }: { account: SharingAccount; onSaved: () => Promise<void>; ui: (key: Parameters<typeof interfaceTranslate>[1]) => string }): ReactElement {
  const [department, setDepartment] = useState(account.sharingAuthorization?.department || account.Department)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  // Optimistic so the toggle answers instantly; the refresh below confirms it.
  const [approved, setApproved] = useState(account.sharingAuthorization?.approved === true)
  // Follow the refreshed record, but never while a save is in flight or the
  // stale pre-save value would flip the toggle straight back.
  useEffect(() => { if (!busy) setApproved(account.sharingAuthorization?.approved === true) }, [account.sharingAuthorization?.approved, busy])
  const save = async (next: boolean): Promise<void> => {
    setBusy(true); setError(''); setApproved(next)
    try {
      const response = await authFetch(`/api/admin/users/${encodeURIComponent(account.id)}/sharing-authorization`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: next, department })
      })
      // A gateway that answers with the SPA shell must not surface as a JSON
      // parse error; every other call site degrades the same way.
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      await onSaved()
    } catch (failure) {
      setApproved(!next)
      setError(failure instanceof Error ? failure.message : ui('adminShareAuthSaveFailed'))
    } finally { setBusy(false) }
  }
  return <div className="admin-sharing-editor">
    {account.deletionState === 'deleting' && <span className="hint">{ui('adminDeletionPending')}</span>}
    <label>{ui('adminShareAuthDepartment')}<input aria-label={`${account.username} ${ui('adminShareAuthDepartment')}`} value={department} disabled={busy || account.deletionState === 'deleting'} onChange={event => setDepartment(event.target.value)} /></label>
    <label className="admin-sharing-toggle">
      <input type="checkbox" aria-label={`${account.username} ${ui('adminShareAuthColumn')}`} checked={approved} disabled={busy || account.deletionState === 'deleting'} onChange={event => void save(event.target.checked)} />
      <span>{approved ? ui('adminShareAuthApproved') : ui('adminShareAuthNotApproved')}</span>
    </label>
    {error && <p role="alert">{error}</p>}
  </div>
}
