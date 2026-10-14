import { useState, type ReactElement } from 'react'
import { authFetch, type AuthUser } from '../../auth/services/auth-client'
import { interfaceTranslate } from '../../../shared/i18n/index'

export type SharingAccount = AuthUser & { deletionState?: 'deleting'; sharingAuthorization?: { approved: boolean; department: string } }
export function SharingAuthorizationEditor({ account, onSaved, ui }: { account: SharingAccount; onSaved: () => Promise<void>; ui: (key: Parameters<typeof interfaceTranslate>[1]) => string }): ReactElement {
  const [department, setDepartment] = useState(account.sharingAuthorization?.department || account.Department)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const save = async (approved: boolean): Promise<void> => {
    setBusy(true); setError('')
    try {
      const response = await authFetch(`/api/admin/users/${encodeURIComponent(account.id)}/sharing-authorization`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved, department })
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      await onSaved()
    } catch (failure) { setError(failure instanceof Error ? failure.message : ui('adminShareAuthSaveFailed')) }
    finally { setBusy(false) }
  }
  return <div className="admin-sharing-editor">
    {account.deletionState === 'deleting' && <span className="hint">{ui('adminDeletionPending')}</span>}
    <label>{ui('adminShareAuthDepartment')}<input aria-label={`${account.username} ${ui('adminShareAuthDepartment')}`} value={department} disabled={busy || account.deletionState === 'deleting'} onChange={event => setDepartment(event.target.value)} /></label>
    <span className="admin-sharing-state">{account.sharingAuthorization?.approved ? ui('adminShareAuthApproved') : ui('adminShareAuthNotApproved')}</span>
    <div className="settings-button-row"><button className="text-button" type="button" disabled={busy || account.deletionState === 'deleting'} onClick={() => void save(true)}>{ui('adminShareAuthApprove')}</button>
    <button className="text-button" type="button" disabled={busy || account.deletionState === 'deleting' || !account.sharingAuthorization?.approved} onClick={() => void save(false)}>{ui('adminShareAuthRevoke')}</button></div>
    {error && <p role="alert">{error}</p>}
  </div>
}
