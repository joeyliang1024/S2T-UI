import { useEffect, useRef, useState, type ReactElement } from 'react'
import { authFetch, type AuthUser } from '../../auth/services/auth-client'
import { interfaceTranslate } from '../../../shared/i18n/index'

export type SharingAccount = AuthUser & { deletionState?: 'deleting'; sharingAuthorization?: { approved: boolean; department: string } }
export function SharingAuthorizationEditor({ account, onSaved, ui }: { account: SharingAccount; onSaved: () => Promise<void>; ui: (key: Parameters<typeof interfaceTranslate>[1]) => string }): ReactElement {
  const remoteDepartment = account.sharingAuthorization?.department ?? account.Department
  const remoteApproved = account.sharingAuthorization?.approved === true
  const [department, setDepartment] = useState(remoteDepartment)
  const [confirmedDepartment, setConfirmedDepartment] = useState(remoteDepartment)
  const confirmedDepartmentRef = useRef(remoteDepartment)
  const [approved, setApproved] = useState(remoteApproved)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    setDepartment(current => current === confirmedDepartmentRef.current ? remoteDepartment : current)
    confirmedDepartmentRef.current = remoteDepartment
    setConfirmedDepartment(remoteDepartment); setApproved(remoteApproved)
    // Refreshes update untouched fields without erasing a locally edited department.
  }, [account.id, remoteDepartment, remoteApproved])
  const save = async (next: boolean): Promise<void> => {
    if (busy) return
    const previousApproved = approved, acceptedDepartment = department
    setBusy(true); setError(''); setApproved(next)
    try {
      const response = await authFetch(`/api/admin/users/${encodeURIComponent(account.id)}/sharing-authorization`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved: next, department: acceptedDepartment })
      })
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      confirmedDepartmentRef.current = acceptedDepartment
      setConfirmedDepartment(acceptedDepartment)
    } catch (failure) {
      setApproved(previousApproved)
      setError(failure instanceof Error ? failure.message : ui('adminShareAuthSaveFailed'))
      setBusy(false); return
    }
    // A committed save must never be rolled back in the UI just because refreshing failed.
    try { await onSaved() }
    catch { setError(ui('adminShareAuthSavedRefreshFailed')) }
    finally { setBusy(false) }
  }
  const disabled = busy || account.deletionState === 'deleting'
  return <div className="admin-sharing-editor">
    {account.deletionState === 'deleting' && <span className="hint">{ui('adminDeletionPending')}</span>}
    <label className="admin-sharing-department" title={ui('adminShareAuthDepartment')}><span>{ui('adminShareAuthDepartmentShort')}</span><input aria-label={`${account.NT} ${ui('adminShareAuthDepartment')}`} value={department} disabled={disabled} onChange={event => setDepartment(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && department !== confirmedDepartment) { event.preventDefault(); void save(approved) } }} /></label>
    <button type="button" className="admin-sharing-save" aria-label={`${account.NT} ${ui('adminShareAuthSave')}`} title={busy ? ui('saving') : ui('adminShareAuthSave')} disabled={disabled || department === confirmedDepartment} onClick={() => void save(approved)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 3h12l4 4v14H3V3h2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></svg></button>
    <label className="admin-sharing-toggle" title={approved ? ui('adminShareAuthApproved') : ui('adminShareAuthNotApproved')}>
      <input type="checkbox" aria-label={`${account.NT} ${ui('adminShareAuthColumn')}`} checked={approved} disabled={disabled} onChange={event => void save(event.target.checked)} />
      <span>{ui('adminShareAuthSharingShort')}</span>
    </label>
    {error && <p role="alert">{error}</p>}
  </div>
}
