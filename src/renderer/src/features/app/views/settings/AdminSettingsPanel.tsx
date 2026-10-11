import { useEffect, useState, type ReactElement } from 'react'
import type { Settings } from '../../../../shared/types'
import { authFetch } from '../../../auth/services/auth-client'
import type { AuthUser } from '../../../auth/services/auth-client'
import { speedToVadConfig } from '../../../capture/vad'
import { bounds, validateAdminParameters, type AdminParameters } from '../../../../../../../server/admin-parameters.cjs'

const labels: Record<keyof AdminParameters,string> = {
  minSpeechMs:'VAD 語音確認時間（ms）',minSilenceMs:'VAD 停頓時間（ms）',preRollMs:'語音前卷（ms）',noiseFloorOffsetDb:'噪音底線偏移（dB）',
  chunkMinMs:'Chunk 最短時間（ms）',chunkMaxMs:'Chunk 最長時間（ms）',translationAggregationMs:'翻譯排程間隔（ms）',translationThrottledMs:'節流翻譯間隔（ms）',
  translationSentenceWaitMs:'整句等待上限（ms）',translationConcurrency:'翻譯並行請求數',translationTemperature:'翻譯 temperature'
}
export function AdminSettingsPanel({user,settings,update}: {user:AuthUser;settings:Settings;update:(fn:(settings:Settings)=>Settings)=>void}): ReactElement | null {
  const [parameterError,setParameterError]=useState('')
  const [users,setUsers]=useState<AuthUser[]>([]),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const [form,setForm]=useState({username:'',password:'',NT:'',Department:'',role:'user'})
  const refresh=async(signal?:AbortSignal):Promise<void>=>{const response=await authFetch('/api/admin/users',{signal});const body=await response.json();if(!response.ok)throw new Error(body.error||'無法載入帳號');setUsers(body.users)}
  useEffect(()=>{if(user.role!=='admin')return;const controller=new AbortController();void refresh(controller.signal).catch(error=>{if(!controller.signal.aborted)setMessage(error.message)});return()=>controller.abort()},[user.id,user.role])
  if(user.role!=='admin')return null
  const defaults={...speedToVadConfig(settings.responseSpeed),translationAggregationMs:220,translationThrottledMs:900,translationSentenceWaitMs:5000,translationConcurrency:2,translationTemperature:.2}
  const parameters={...defaults,...settings.adminParameters}
  const create=async():Promise<void>=>{setBusy(true);setMessage('');try{const response=await authFetch('/api/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(form)});const body=await response.json();if(!response.ok)throw new Error(body.error||'新增帳號失敗');setForm({username:'',password:'',NT:'',Department:'',role:'user'});await refresh();setMessage('帳號已建立，不會切換目前的 admin 登入')}catch(error){setMessage(error instanceof Error?error.message:'新增失敗')}finally{setBusy(false)}}
  return <>
    <section className="settings-card"><header className="settings-card-header"><h3>帳號管理</h3></header><div className="settings-card-body">
      <p>目前：{user.username} · {user.NT} · {user.Department} · admin</p>
      <table className="admin-account-table"><thead><tr><th>帳號</th><th>NT</th><th>Department</th><th>角色</th></tr></thead><tbody>{users.map(account=><tr key={account.id}><td>{account.username}</td><td>{account.NT}</td><td>{account.Department}</td><td>{account.role}</td></tr>)}</tbody></table>
      <form onSubmit={event=>{event.preventDefault();void create()}} className="admin-settings-grid">
        {(['username','NT','Department','password'] as const).map(key=><label key={key}>{key==='password'?'初始密碼':key==='username'?'帳號':key==='Department'?'部門':key}<input required autoComplete={key==='password'?'new-password':'off'} type={key==='password'?'password':'text'} minLength={key==='password'?8:undefined} value={form[key]} onChange={event=>setForm(current=>({...current,[key]:event.target.value}))}/></label>)}
        <label>角色<select value={form.role} onChange={event=>setForm(current=>({...current,role:event.target.value}))}><option value="user">一般帳號</option><option value="admin">Admin</option></select></label>
        <button disabled={busy} type="submit">新增帳號</button>
      </form>{message&&<p role="status">{message}</p>}
    </div></section>
    <section className="settings-card"><header className="settings-card-header"><h3>Admin：VAD 與翻譯進階參數</h3></header><div className="settings-card-body">
      <p>只影響此 admin 帳號。啟用後，客製 VAD 值優先於回應速度滑桿。VAD 與排程在下一個 chunk／排程週期套用；Web 設定會隨帳號保存；桌面版請按頁面儲存。正在執行的翻譯不會更換參數。</p>
      <label><input type="checkbox" checked={settings.adminParameters!==undefined} onChange={event=>update(current=>({...current,adminParameters:event.target.checked?defaults:undefined}))}/>使用客製化參數</label>
      {parameterError&&<p role="alert">{parameterError}</p>}
      {settings.adminParameters!==undefined&&<div className="admin-settings-grid">{(Object.keys(bounds) as Array<keyof AdminParameters>).map(key=><label key={key}>{labels[key]}<input type="number" min={bounds[key][0]} max={bounds[key][1]} step={key==='translationTemperature'?.05:1} value={parameters[key]} onChange={event=>{try{const next=validateAdminParameters({...parameters,[key]:event.target.valueAsNumber});setParameterError('');update(current=>({...current,adminParameters:next}))}catch(error){setParameterError(error instanceof Error?error.message:'參數無效')}}}/><small>{bounds[key][0]}–{bounds[key][1]}</small></label>)}</div>}
    </div></section>
  </>
}
