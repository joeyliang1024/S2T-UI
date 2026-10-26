import { useEffect, useRef, useState, type ReactElement } from 'react'
import { dbfsLabel, meterPercent } from '../../../shared/services/audio'

type AudioDevice = { deviceId: string; label: string }
type Props = {
  selectedDeviceId: string
  devices: AudioDevice[]
  denoiseEnabled: boolean
  disabled: boolean
  ui: (key: string) => string
  apply: (deviceId: string) => Promise<void>
  includeSystemAudio?: boolean
  existingSystemStream?: MediaStream | null
  applyAudio?: (deviceId: string, systemEnabled: boolean, stream?: MediaStream) => Promise<void>
  confirmLabel?: string
  close: () => void
  details: () => void
}

export function MicrophoneSetupDialog({ selectedDeviceId, devices, denoiseEnabled, disabled, ui, apply, includeSystemAudio = false, existingSystemStream = null, applyAudio, confirmLabel, close, details }: Props): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const release = useRef<() => void>(() => {})
  const [candidate, setCandidate] = useState(selectedDeviceId)
  const [available, setAvailable] = useState(devices)
  const [level, setLevel] = useState(-60)
  const [detected, setDetected] = useState(false)
  const [connecting, setConnecting] = useState(candidate !== 'none')
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState('')
  const [retry, setRetry] = useState(0)
  const [systemEnabled, setSystemEnabled] = useState(includeSystemAudio)
  const [systemStream, setSystemStream] = useState<MediaStream | null>(existingSystemStream)
  const [systemLevel, setSystemLevel] = useState(-60)
  const [systemDetected, setSystemDetected] = useState(false)
  const [systemError, setSystemError] = useState('')
  const [pickingSystem, setPickingSystem] = useState(false)
  const ownedSystem = useRef<MediaStream | null>(null)
  const mounted = useRef(true)
  const confirming = useRef(false)
  const busy = applying || disabled || pickingSystem
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ownedSystem.current?.getTracks().forEach(track => track.stop()) } }, [])
  useEffect(() => {
    setSystemLevel(-60); setSystemDetected(false)
    if (!systemEnabled || !systemStream) return
    let canceled = false, frame = 0
    if (!systemStream.getAudioTracks().some(track => track.readyState === 'live')) { setSystemStream(null); setSystemError(ui('systemAudioTestFailed')); return }
    let context: AudioContext | undefined
    let analyser: AnalyserNode
    try {
      context = new AudioContext()
      analyser = context.createAnalyser()
      analyser.fftSize = 2048
      context.createMediaStreamSource(systemStream).connect(analyser)
    } catch {
      if (context && context.state !== 'closed') void context.close().catch(() => {})
      setSystemError(ui('systemAudioTestFailed'))
      return
    }
    const samples = new Float32Array(analyser.fftSize)
    let lastPaint = 0
    const measure = (now: number): void => {
      if (canceled) return
      if (now - lastPaint >= 80) {
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
        const db = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(rms, 1e-8))))
        setSystemLevel(db)
        if (db > -50) setSystemDetected(true)
        lastPaint = now
      }
      frame = requestAnimationFrame(measure)
    }
    void context.resume().then(() => { if (!canceled) frame = requestAnimationFrame(measure) }).catch(() => { if (!canceled) setSystemError(ui('systemAudioTestFailed')) })
    const ended = (): void => { if (!canceled) { setSystemStream(null); setSystemError(ui('systemAudioTestFailed')) } }
    systemStream.getAudioTracks().forEach(track => track.addEventListener('ended', ended, { once: true }))
    return () => { canceled = true; cancelAnimationFrame(frame); systemStream.getAudioTracks().forEach(track => track.removeEventListener('ended', ended)); if (context.state !== 'closed') void context.close().catch(() => {}) }
  }, [systemEnabled, systemStream])
  const chooseSystem = async (): Promise<void> => {
    setPickingSystem(true); setSystemError('')
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      if (!mounted.current) { stream.getTracks().forEach(track => track.stop()); return }
      if (!stream.getAudioTracks().some(track => track.readyState === 'live')) { stream.getTracks().forEach(track => track.stop()); setSystemError(ui('systemAudioTestFailed')); return }
      ownedSystem.current?.getTracks().forEach(track => track.stop())
      ownedSystem.current = stream
      setSystemStream(stream); setSystemEnabled(true)
    } catch { if (mounted.current) setSystemError(ui('systemAudioTestFailed')) }
    finally { if (mounted.current) setPickingSystem(false) }
  }


  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal()
    return () => { release.current(); previous?.focus() }
  }, [])

  useEffect(() => {
    let canceled = false, frame = 0
    let stream: MediaStream | undefined, context: AudioContext | undefined
    const stop = (): void => {
      canceled = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach(track => track.stop())
      if (context && context.state !== 'closed') void context.close().catch(() => {})
    }
    release.current = stop
    setDetected(false); setLevel(-60); setError(''); setConnecting(candidate !== 'none')
    if (candidate === 'none') return stop
    const refresh = async (): Promise<void> => {
      const found = await navigator.mediaDevices.enumerateDevices()
      if (!canceled) setAvailable(found.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default'))
    }
    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(candidate === 'default' ? {} : { deviceId: { exact: candidate } }), echoCancellation: true, noiseSuppression: denoiseEnabled, autoGainControl: true }, video: false })
        if (canceled) { stream.getTracks().forEach(track => track.stop()); return }
        stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
          if (!canceled) { stop(); setError(ui('microphoneTestFailed')); setConnecting(false); setLevel(-60) }
        }, { once: true }))
        context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 2048
        context.createMediaStreamSource(stream).connect(analyser)
        await context.resume()
        if (canceled) return
        await refresh()
        if (canceled) return
        setConnecting(false)
        const samples = new Float32Array(analyser.fftSize)
        let lastPaint = 0, soundFrames = 0
        const measure = (now: number): void => {
          if (canceled) return
          if (now - lastPaint >= 80) {
            analyser.getFloatTimeDomainData(samples)
            const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
            const db = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(rms, 1e-8))))
            setLevel(db)
            soundFrames = db > -50 ? soundFrames + 1 : 0
            if (soundFrames >= 2) setDetected(true)
            lastPaint = now
          }
          frame = requestAnimationFrame(measure)
        }
        frame = requestAnimationFrame(measure)
      } catch {
        if (!canceled) { setError(ui('microphoneTestFailed')); setConnecting(false); stop() }
      }
    }
    const changed = (): void => { void refresh().catch(() => {}) }
    navigator.mediaDevices?.addEventListener('devicechange', changed)
    void start()
    return () => { navigator.mediaDevices?.removeEventListener('devicechange', changed); stop() }
  }, [candidate, denoiseEnabled, retry])

  const canConfirm = !busy && !connecting && !error && (!applyAudio || ((candidate !== 'none' || systemEnabled) && (!systemEnabled || Boolean(systemStream?.getAudioTracks().some(track => track.readyState === 'live')))))
  const confirm = async (): Promise<void> => {
    if (!canConfirm || confirming.current) return
    confirming.current = true
    setApplying(true); setApplyError(''); release.current()
    try {
      if (applyAudio) { await applyAudio(candidate, systemEnabled, systemEnabled ? systemStream ?? undefined : undefined); if (systemEnabled) ownedSystem.current = null }
      else await apply(candidate)
      close()
    }
    catch { if (mounted.current) { setApplying(false); setRetry(current => current + 1); setApplyError(ui('microphoneApplyFailed')) } }
    finally { confirming.current = false }
  }
  return <dialog id="microphone-setup" ref={dialog} className="microphone-setup-dialog" aria-labelledby="microphone-setup-title" aria-describedby="microphone-setup-hint" onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <form onSubmit={event => { event.preventDefault(); void confirm() }}>
      <header><h2 id="microphone-setup-title">{ui(applyAudio ? 'audioSourcesSetup' : 'microphoneSetup')}</h2><button type="button" className="text-button" aria-label={ui('close')} disabled={busy} onClick={close}>×</button></header>
      <p id="microphone-setup-hint" className="hint">{ui(applyAudio ? 'audioSourcesHint' : 'microphoneTestHint')}</p>
      <label>{ui('microphone')}<select aria-label={ui('microphone')} autoFocus value={candidate} disabled={busy} onChange={event => { setApplyError(''); setCandidate(event.target.value) }}><option value="default">{ui('systemDefaultMicrophone')}</option><option value="none">{ui('notInUse')}</option>{available.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `${ui('microphone')} ${index + 1}`}</option>)}</select></label>
      <div className="microphone-preview-meter">
        <div className="meter-label"><span>{ui('microphoneLevel')}</span><strong>{dbfsLabel(level)}</strong></div>
        <div className="meter-track" role="meter" aria-label={ui('microphoneLevel')} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(level)}><div className="meter-value" style={{ width: `${meterPercent(level)}%` }} /></div>
      </div>
      <p className={`microphone-test-state${detected ? ' detected' : ''}`} role="status">{candidate === 'none' ? ui('microphoneNoInput') : connecting ? ui('microphoneTesting') : error ? '' : detected ? ui('microphoneSoundDetected') : ui('microphoneWaitingSound')}</p>
      {error && <p role="alert">{error} <button type="button" className="text-button" disabled={busy} onClick={() => setRetry(current => current + 1)}>{ui('microphoneRetry')}</button></p>}
      {applyAudio && <section className="system-audio-preview" aria-label={ui('computerAudio')}>
        <label>{ui('computerAudio')}<select aria-label={ui('computerAudio')} value={systemEnabled ? 'system' : 'none'} disabled={busy} onChange={event => { setSystemError(''); setSystemEnabled(event.target.value === 'system') }}><option value="none">{ui('notInUse')}</option><option value="system">{ui('computerAudio')}</option></select></label>
        {systemEnabled && <>
          <button type="button" className="secondary audio-dialog-button audio-dialog-wide" disabled={busy} onClick={() => void chooseSystem()}>{ui('chooseComputerAudio')}</button>
          <p className="hint">{ui('systemAudioShareHint')}</p>
          <div className="microphone-preview-meter"><div className="meter-label"><span>{ui('computerAudioLevel')}</span><strong>{dbfsLabel(systemLevel)}</strong></div><div className="meter-track" role="meter" aria-label={ui('computerAudioLevel')} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(systemLevel)}><div className="meter-value" style={{ width: `${meterPercent(systemLevel)}%` }} /></div></div>
          <p role="status">{systemStream ? ui(systemDetected ? 'microphoneSoundDetected' : 'systemAudioWaitingSound') : ui('notConnected')}</p>
        </>}
        {systemError && <p role="alert">{systemError}</p>}
      </section>}
      {applyError && <p role="alert">{applyError}</p>}
      <p className="hint">{ui('microphoneTestOnly')}</p>
      <footer><button type="button" className="secondary audio-dialog-button audio-dialog-wide" disabled={busy} onClick={() => { close(); details() }}>{ui('captureAdvancedSettings')}</button><div><button type="button" className="danger audio-dialog-button" disabled={busy} onClick={close}>{ui('cancel')}</button><button type="submit" className="primary audio-dialog-button" disabled={!canConfirm}>{confirmLabel ?? ui('microphoneApply')}</button></div></footer>
    </form>
  </dialog>
}
