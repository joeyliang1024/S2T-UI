import { SharingAuthorizationEditor, type SharingAccount } from './SharingAuthorizationEditor'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Settings } from '../../../shared/types'
import { authFetch } from '../../auth/services/auth-client'
import type { AuthUser } from '../../auth/services/auth-client'
import { speedToVadConfig } from '../../capture/vad'
import { bounds, validateAdminParameters, type AdminParameters } from '../../../../../shared/validation/admin-parameters.cjs'
import { interfaceTranslate } from '../../../shared/i18n/index'

const parameterKeys: Record<keyof AdminParameters, 'admParamMinSpeechMs' | 'admParamMinSilenceMs' | 'admParamPreRollMs' | 'admParamNoiseFloorOffsetDb' | 'admParamChunkMinMs' | 'admParamChunkMaxMs' | 'admParamTranslationAggregationMs' | 'admParamTranslationThrottledMs' | 'admParamTranslationSentenceWaitMs' | 'admParamTranslationConcurrency' | 'admParamTranslationTemperature'> = {
  minSpeechMs: 'admParamMinSpeechMs', minSilenceMs: 'admParamMinSilenceMs', preRollMs: 'admParamPreRollMs', noiseFloorOffsetDb: 'admParamNoiseFloorOffsetDb',
  chunkMinMs: 'admParamChunkMinMs', chunkMaxMs: 'admParamChunkMaxMs', translationAggregationMs: 'admParamTranslationAggregationMs', translationThrottledMs: 'admParamTranslationThrottledMs',
  translationSentenceWaitMs: 'admParamTranslationSentenceWaitMs', translationConcurrency: 'admParamTranslationConcurrency', translationTemperature: 'admParamTranslationTemperature'
}
export function AdminSettingsPanel({user,settings,update}: {user:AuthUser;settings:Settings;update:(fn:(settings:Settings)=>Settings)=>void}): ReactElement | null {
  const [parameterError,setParameterError]=useState('')
  const [users,setUsers]=useState<SharingAccount[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const [deletingAccount, setDeletingAccount] = useState<SharingAccount | null>(null)
  const [deleteName, setDeleteName] = useState(''), [deleteError, setDeleteError] = useState('')
  const deleteDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (deletingAccount) deleteDialog.current?.showModal() }, [deletingAccount])
  const [form,setForm]=useState({username:'',password:'',NT:'',Department:'',role:'user'})
  const ui=(key: Parameters<typeof interfaceTranslate>[1]): string => interfaceTranslate(settings.uiLanguage, key)
  const refresh=async(signal?:AbortSignal):Promise<void>=>{const response=await authFetch('/api/admin/users',{signal});const body=await response.json();if(!response.ok)throw new Error(body.error||ui('adminAccountsLoadFailed'));setUsers(body.users)}
  useEffect(()=>{if(user.role!=='admin')return;const controller=new AbortController();void refresh(controller.signal).catch(error=>{if(!controller.signal.aborted)setMessage(error.message)});return()=>controller.abort()},[user.id,user.role])
  if(user.role!=='admin')return null
  const defaults={...speedToVadConfig(settings.responseSpeed),translationAggregationMs:220,translationThrottledMs:900,translationSentenceWaitMs:5000,translationConcurrency:2,translationTemperature:.2}
  const parameters={...defaults,...settings.adminParameters}
  const create=async():Promise<void>=>{setBusy(true);setMessage('');try{const response=await authFetch('/api/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(form)});const body=await response.json();if(!response.ok)throw new Error(body.error||ui('adminCreateAccountFailed'));setForm({username:'',password:'',NT:'',Department:'',role:'user'});await refresh();setMessage(ui('adminAccountCreated'))}catch(error){setMessage(error instanceof Error?error.message:ui('adminCreateFailed'))}finally{setBusy(false)}}
  const removeAccount = async (): Promise<void> => {
    if (!deletingAccount || deletingAccount.id === user.id || deleteName !== deletingAccount.username || busy) return
    setBusy(true); setDeleteError(''); setMessage('')
    try {
      const response = await authFetch(`/api/admin/users/${encodeURIComponent(deletingAccount.id)}`, { method: 'DELETE' })
      const body = response.status === 204 ? {} : await response.json()
      if (!response.ok) throw new Error(body.error || ui('adminDeleteAccountFailed'))
      setUsers(current => current.filter(account => account.id !== deletingAccount.id))
      setDeletingAccount(null); setDeleteName(''); setMessage(ui('adminAccountDeleted'))
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : ui('adminDeleteAccountFailed'))
    } finally { setBusy(false) }
  }
  return <>
    <section className="settings-card"><header className="settings-card-header"><h3>{ui('adminAccountManagement')}</h3></header><div className="settings-card-body">
      <p>{ui('adminCurrentAccount')}{user.username} · {user.NT} · {user.Department} · admin</p>
      <div className="admin-account-table-scroll" role="region" aria-label={ui('adminAccountManagement')} tabIndex={0}>
        <table className="admin-account-table">
          <colgroup><col /><col /><col /><col className="admin-role-column" /><col className="admin-sharing-column" /><col className="admin-actions-column" /></colgroup>
          <thead><tr><th>{ui('adminAccount')}</th><th>NT</th><th>{ui('adminFieldDepartment')}</th><th>{ui('adminRole')}</th><th>{ui('adminShareAuthColumn')}</th><th>{ui('adminAccountActions')}</th></tr></thead>
          <tbody>{users.map(account => <tr key={account.id}>
            <td>{account.username}</td><td>{account.NT}</td><td>{account.Department}</td><td>{account.role === 'admin' ? 'Admin' : ui('adminRoleUser')}</td>
            <td><SharingAuthorizationEditor account={account} onSaved={refresh} ui={ui} /></td>
            <td>{account.id === user.id ? <span className="hint">{ui('adminOwnAccount')}</span> : <button className="text-button danger" type="button" disabled={busy} aria-label={`${ui('adminDeleteAccount')}: ${account.username}`} onClick={() => { setDeletingAccount(account); setDeleteName(''); setDeleteError('') }}>{ui(account.deletionState === 'deleting' ? 'adminRetryDeletion' : 'adminDeleteAccount')}</button>}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <form onSubmit={event=>{event.preventDefault();void create()}} className="admin-settings-grid">
        {(['username','NT','Department','password'] as const).map(key=><label key={key}>{key==='password'?ui('adminFieldPassword'):key==='username'?ui('adminAccount'):key==='Department'?ui('adminFieldDepartment'):key}<input required autoComplete={key==='password'?'new-password':'off'} type={key==='password'?'password':'text'} minLength={key==='password'?8:undefined} value={form[key]} onChange={event=>setForm(current=>({...current,[key]:event.target.value}))}/></label>)}
        <label>{ui('adminRole')}<select value={form.role} onChange={event=>setForm(current=>({...current,role:event.target.value}))}><option value="user">{ui('adminRoleUser')}</option><option value="admin">Admin</option></select></label>
        <button className="primary" disabled={busy} type="submit">{ui('adminCreateAccount')}</button>
      </form>{message&&<p role="status">{message}</p>}
    </div></section>
    <section className="settings-card"><header className="settings-card-header"><h3>{ui('adminAdvancedParams')}</h3></header><div className="settings-card-body">
      <p>{ui('adminAdvancedParamsHint')}</p>
      <label><input type="checkbox" checked={settings.adminParameters!==undefined} onChange={event=>update(current=>({...current,adminParameters:event.target.checked?defaults:undefined}))}/>{ui('adminUseCustomParams')}</label>
      {parameterError&&<p role="alert">{parameterError}</p>}
      {settings.adminParameters!==undefined&&<div className="admin-settings-grid">{(Object.keys(bounds) as Array<keyof AdminParameters>).map(key=><label key={key}>{ui(parameterKeys[key])}<input type="number" min={bounds[key][0]} max={bounds[key][1]} step={key==='translationTemperature'?.05:1} value={parameters[key]} onChange={event=>{try{const next=validateAdminParameters({...parameters,[key]:event.target.valueAsNumber});setParameterError('');update(current=>({...current,adminParameters:next}))}catch(error){setParameterError(error instanceof Error?error.message:ui('adminParamInvalid'))}}}/><small>{bounds[key][0]}–{bounds[key][1]}</small></label>)}</div>}
    </div></section>
    {deletingAccount && <dialog ref={deleteDialog} className="admin-delete-dialog" aria-labelledby="admin-delete-title" aria-describedby="admin-delete-hint" onCancel={event => { if (busy) event.preventDefault(); else setDeletingAccount(null) }}>
      <form onSubmit={event => { event.preventDefault(); void removeAccount() }}>
        <h3 id="admin-delete-title">{ui('adminDeleteAccount')}: {deletingAccount.username}</h3>
        <p id="admin-delete-hint">{ui('adminDeleteAccountHint')}</p>
        <label>{ui('adminDeleteConfirmName')}<input autoFocus autoComplete="off" value={deleteName} disabled={busy} onChange={event => setDeleteName(event.target.value)} /></label>
        {deleteError && <p role="alert">{deleteError}</p>}
        {busy && <p role="status">{ui('adminDeletingAccount')}</p>}
        <div className="settings-button-row"><button className="text-button" type="button" disabled={busy} onClick={() => setDeletingAccount(null)}>{ui('cancel')}</button><button className="text-button danger" type="submit" disabled={busy || deleteName !== deletingAccount.username}>{ui('adminDeleteAccount')}</button></div>
      </form>
    </dialog>}
  </>
}
