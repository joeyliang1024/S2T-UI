import { useRef, type ReactElement } from 'react'

type Health = { state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; reason: string; checkedAt: number }

export function ModelHealthIndicator({ health, ui }: { health?: Health; ui: (key: string) => string }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const state = health?.state ?? 'unknown'
  const label = ui(state === 'healthy' ? 'modelHealthHealthy' : state === 'degraded' ? 'modelHealthDegraded' : state === 'unhealthy' ? 'modelHealthFailed' : 'modelHealthUnknown')
  return <>
    <button type="button" className={`model-health ${state}`} aria-label={`${ui('modelHealthReason')}: ${label}`} aria-haspopup="dialog" title={ui('modelHealthReason')} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); dialog.current?.showModal() }}><i aria-hidden="true" />{label}</button>
    <dialog ref={dialog} className="model-health-dialog" aria-label={ui('modelHealthReason')} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <header><h2>{ui('modelHealthReason')}</h2><button type="button" className="text-button" onClick={() => dialog.current?.close()}>{ui('close')}</button></header>
      <p className={`model-health ${state}`}><i aria-hidden="true" />{label}</p>
      <p className="model-health-reason">{health?.reason || ui('modelHealthNotChecked')}</p>
    </dialog>
  </>
}
