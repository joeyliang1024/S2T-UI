import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { NoopModelAdapter, type TranscriptEvent } from './model-adapter'

type CaptureState = 'idle' | 'recording' | 'paused' | 'saving'
type AudioDevice = { deviceId: string; label: string }
type View = 'live' | 'history' | 'import' | 'settings'
type SavedSession = {
  id: string
  title: string
  createdAt: string
  durationMs: number
  source: string
  transcript: string
}
type Settings = { sourceLanguage: string; targetLanguage: string; modelEndpoint: string }

const sessionsKey = 's2t-ui.sessions.v1'
const settingsKey = 's2t-ui.settings.v1'

const dbfs = (value: number): number => (value > 0 ? Math.max(-60, 20 * Math.log10(value)) : -60)
const timestamp = (milliseconds: number): string => {
  const total = Math.floor(milliseconds / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const makeSrt = (entries: TranscriptEvent[]): string => entries
  .filter((entry) => entry.status === 'final')
  .map((entry, index) => {
    const format = (ms: number): string => `${new Date(ms).toISOString().slice(11, 23).replace('.', ',')}`
    return `${index + 1}\n${format(entry.startMs)} --> ${format(entry.endMs)}\n${entry.sourceText}${entry.translatedText ? `\n${entry.translatedText}` : ''}`
  })
  .join('\n\n')

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

const browserDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export default function App(): ReactElement {
  const isFloatingCaptionWindow = window.location.hash === '#floating'
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('default')
  const [captureState, setCaptureState] = useState<CaptureState>('idle')
  const [level, setLevel] = useState(-60)
  const [peak, setPeak] = useState(-60)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [transcripts, setTranscripts] = useState<TranscriptEvent[]>([])
  const [status, setStatus] = useState('準備就緒')
  const [view, setView] = useState<View>('live')
  const [sessions, setSessions] = useState<SavedSession[]>(() => loadJson<SavedSession[]>(sessionsKey, []))
  const [settings, setSettings] = useState<Settings>(() => loadJson<Settings>(settingsKey, {
    sourceLanguage: 'zh-TW', targetLanguage: 'en', modelEndpoint: ''
  }))
  const [importedFile, setImportedFile] = useState<File | null>(null)
  const [importError, setImportError] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [floatingCaptions, setFloatingCaptions] = useState(false)
  const [floatingCaptionText, setFloatingCaptionText] = useState('等待字幕')

  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const silentGainRef = useRef<GainNode | null>(null)
  const recordingDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startAtRef = useRef(0)
  const pausedDurationRef = useRef(0)
  const pauseStartedAtRef = useRef<number | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const modelRef = useRef(new NoopModelAdapter())
  const sampleOffsetRef = useRef(0)
  const activeDeviceIdRef = useRef('default')

  const refreshDevices = useCallback(async () => {
    const found = await navigator.mediaDevices.enumerateDevices()
    const inputs = found
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `音訊輸入 ${index + 1}` }))
    setDevices(inputs)
  }, [])

  useEffect(() => {
    const onDeviceChange = (): void => {
      void refreshDevices()
      if (streamRef.current?.getAudioTracks().some((track) => track.readyState === 'ended')) {
        setStatus('目前音源已移除。請選擇其他音源，錄音會持續寫入。')
      }
    }
    void refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
  }, [refreshDevices])

  useEffect(() => modelRef.current.onTranscript((event) => {
    setTranscripts((current) => {
      const existing = current.findIndex((entry) => entry.id === event.id)
      if (existing < 0) return [...current, event].sort((a, b) => a.startMs - b.startMs)
      const next = [...current]
      if (event.revision >= next[existing].revision) next[existing] = event
      return next
    })
  }), [])

  useEffect(() => {
    if (!isFloatingCaptionWindow) return
    return window.s2t?.onFloatingCaption(setFloatingCaptionText)
  }, [isFloatingCaptionWindow])

  useEffect(() => {
    if (isFloatingCaptionWindow || !floatingCaptions) return
    const latest = [...transcripts].reverse().find((entry) => entry.sourceText.trim())
    window.s2t?.updateFloatingCaption(latest ? `${latest.sourceText}${latest.translatedText ? `\n${latest.translatedText}` : ''}` : '等待字幕')
  }, [floatingCaptions, isFloatingCaptionWindow, transcripts])

  useEffect(() => {
    window.localStorage.setItem(sessionsKey, JSON.stringify(sessions))
  }, [sessions])

  useEffect(() => {
    window.localStorage.setItem(settingsKey, JSON.stringify(settings))
  }, [settings])

  const cleanUpCapture = useCallback(() => {
    if (meterFrameRef.current) cancelAnimationFrame(meterFrameRef.current)
    if (timerRef.current) window.clearInterval(timerRef.current)
    meterFrameRef.current = null
    timerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    sourceRef.current?.disconnect()
    sourceRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
    analyserRef.current = null
    processorRef.current?.disconnect()
    processorRef.current = null
    silentGainRef.current?.disconnect()
    silentGainRef.current = null
    recordingDestinationRef.current?.disconnect()
    recordingDestinationRef.current = null
  }, [])

  useEffect(() => cleanUpCapture, [cleanUpCapture])

  const updateMeter = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    let max = 0
    for (const sample of samples) {
      sum += sample * sample
      max = Math.max(max, Math.abs(sample))
    }
    const rms = dbfs(Math.sqrt(sum / samples.length))
    setLevel(rms)
    setPeak((current) => Math.max(rms, current - 0.8, dbfs(max)))
    meterFrameRef.current = requestAnimationFrame(updateMeter)
  }, [])

  const attachInput = useCallback((stream: MediaStream, context: AudioContext): void => {
    const source = context.createMediaStreamSource(stream)
    const analyser = analyserRef.current
    const processor = processorRef.current
    const recordingDestination = recordingDestinationRef.current
    if (!analyser || !processor || !recordingDestination) throw new Error('音訊管線尚未就緒')
    source.connect(analyser)
    source.connect(processor)
    source.connect(recordingDestination)
    sourceRef.current = source
    streamRef.current = stream
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (streamRef.current === stream) {
          setStatus('目前音源已中斷。請從音源選單切換至可用裝置。')
          void refreshDevices()
        }
      }, { once: true })
    })
  }, [refreshDevices])

  const switchInput = useCallback(async (nextDeviceId: string): Promise<void> => {
    const context = contextRef.current
    if (!context) return
    const previousStream = streamRef.current
    const previousSource = sourceRef.current
    setStatus('正在切換音源…')
    try {
      const deviceId = nextDeviceId === 'default' ? undefined : { exact: nextDeviceId }
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      })
      attachInput(nextStream, context)
      previousSource?.disconnect()
      previousStream?.getTracks().forEach((track) => track.stop())
      activeDeviceIdRef.current = nextDeviceId
      setSelectedDeviceId(nextDeviceId)
      setStatus(captureState === 'paused' ? '已暫停，音源已切換' : '收音中，音源已切換')
    } catch (error) {
      setSelectedDeviceId(activeDeviceIdRef.current)
      setStatus(error instanceof Error ? `無法切換音源：${error.message}` : '無法切換音源')
    }
  }, [attachInput, captureState])

  const selectDevice = (nextDeviceId: string): void => {
    if (captureState === 'recording' || captureState === 'paused') {
      void switchInput(nextDeviceId)
      return
    }
    setSelectedDeviceId(nextDeviceId)
  }

  const startCapture = async (): Promise<void> => {
    try {
      setStatus('正在要求麥克風權限…')
      const deviceId = selectedDeviceId === 'default' ? undefined : { exact: selectedDeviceId }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      })
      streamRef.current = stream
      await refreshDevices()

      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      const processor = context.createScriptProcessor(4096, 1, 1)
      const silentGain = context.createGain()
      const recordingDestination = context.createMediaStreamDestination()
      silentGain.gain.value = 0
      sampleOffsetRef.current = 0
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0).slice()
        modelRef.current.pushAudio(samples, sampleOffsetRef.current)
        sampleOffsetRef.current += samples.length
      }
      processor.connect(silentGain)
      silentGain.connect(context.destination)
      contextRef.current = context
      analyserRef.current = analyser
      processorRef.current = processor
      silentGainRef.current = silentGain
      recordingDestinationRef.current = recordingDestination
      attachInput(stream, context)
      meterFrameRef.current = requestAnimationFrame(updateMeter)

      chunksRef.current = []
      const recorder = new MediaRecorder(recordingDestination.stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined })
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorderRef.current = recorder
      recorder.start(1000)
      await modelRef.current.start({ sampleRate: context.sampleRate, language: settings.sourceLanguage, targetLanguage: settings.targetLanguage })

      startAtRef.current = Date.now()
      activeDeviceIdRef.current = selectedDeviceId
      pausedDurationRef.current = 0
      setElapsedMs(0)
      timerRef.current = window.setInterval(() => setElapsedMs(Date.now() - startAtRef.current - pausedDurationRef.current), 250)
      setCaptureState('recording')
      setStatus('收音中。模型尚未接入，字幕會在模型適配器完成後顯示。')
    } catch (error) {
      cleanUpCapture()
      setStatus(error instanceof Error ? `無法開始收音：${error.message}` : '無法開始收音')
    }
  }

  const togglePause = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder) return
    if (captureState === 'recording') {
      recorder.pause()
      pauseStartedAtRef.current = Date.now()
      setCaptureState('paused')
      setStatus('已暫停')
    } else if (captureState === 'paused') {
      recorder.resume()
      if (pauseStartedAtRef.current) pausedDurationRef.current += Date.now() - pauseStartedAtRef.current
      pauseStartedAtRef.current = null
      setCaptureState('recording')
      setStatus('收音中')
    }
  }

  const stopAndSave = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder) return
    setCaptureState('saving')
    setStatus('正在完成錄音並儲存…')
    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true })
      recorder.stop()
    })
    try {
      await modelRef.current.stop()
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      const transcript = transcripts
        .filter((entry) => entry.status === 'final')
        .map((entry) => `[${timestamp(entry.startMs)}] ${entry.sourceText}${entry.translatedText ? `\n${entry.translatedText}` : ''}`)
        .join('\n\n')
      const name = `s2t-${new Date().toISOString().replace(/[:.]/g, '-')}`

      if (window.s2t) {
        const result = await window.s2t.saveSession({ name, audio: await blob.arrayBuffer(), transcript })
        setStatus(result.canceled ? '已取消儲存' : `已儲存錄音與逐字稿：${result.audioPath}`)
      } else {
        browserDownload(blob, `${name}.webm`)
        browserDownload(new Blob([transcript], { type: 'text/plain;charset=utf-8' }), `${name}.txt`)
        setStatus('已下載錄音與逐字稿')
      }
      setSessions((current) => [{
        id: crypto.randomUUID(),
        title: name,
        createdAt: new Date().toISOString(),
        durationMs: elapsedMs,
        source: selectedDeviceId === 'default' ? '系統預設麥克風' : (devices.find((device) => device.deviceId === selectedDeviceId)?.label ?? '已選擇的音源'),
        transcript
      }, ...current])
    } catch (error) {
      setStatus(error instanceof Error ? `儲存失敗：${error.message}` : '儲存失敗')
    } finally {
      cleanUpCapture()
      recorderRef.current = null
      setCaptureState('idle')
      setLevel(-60)
      setPeak(-60)
    }
  }

  const forceReleaseCapture = (): void => {
    cleanUpCapture()
    recorderRef.current = null
    setCaptureState('idle')
    setLevel(-60)
    setPeak(-60)
    setStatus('已停止並釋放麥克風；未完成的儲存可能遺失。')
  }

  const exportTranscript = (format: 'txt' | 'srt' | 'json'): void => {
    const name = `s2t-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const content = format === 'srt' ? makeSrt(transcripts) : format === 'json'
      ? JSON.stringify(transcripts.filter((entry) => entry.status === 'final'), null, 2)
      : transcripts.filter((entry) => entry.status === 'final').map((entry) => `[${timestamp(entry.startMs)}] ${entry.sourceText}${entry.translatedText ? `\n${entry.translatedText}` : ''}`).join('\n\n')
    browserDownload(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }), `${name}.${format}`)
    setStatus(`已下載 ${format.toUpperCase()} 字幕檔`)
  }

  const saveSettings = (): void => {
    setSettingsSaved(true)
    window.setTimeout(() => setSettingsSaved(false), 2400)
  }

  const toggleFloatingCaptions = (): void => {
    const next = !floatingCaptions
    setFloatingCaptions(next)
    window.s2t?.toggleFloatingCaptions(next)
    setStatus(next ? '已開啟浮動字幕窗' : '已隱藏浮動字幕窗')
  }

  const selectImportFile = (file: File | null): void => {
    setImportedFile(null)
    setImportError('')
    if (!file) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    const acceptedExtensions = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'webm', 'flac', 'mp4', 'mov'])
    if (!acceptedExtensions.has(extension ?? '')) {
      setImportError('不支援此檔案格式。請選擇 WAV、MP3、M4A、AAC、OGG、WebM、FLAC、MP4 或 MOV。')
      return
    }
    if (file.size === 0) {
      setImportError('無法匯入空白檔案。')
      return
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      setImportError('檔案超過 2 GB，目前版本無法安全處理。')
      return
    }
    setImportedFile(file)
  }

  const canRecord = captureState === 'idle'
  const isActive = captureState === 'recording' || captureState === 'paused'

  const liveWorkspace = (
    <>
      <section className="capture-panel" aria-label="音訊來源與音量">
        <label>
          音源
          <select value={selectedDeviceId} onChange={(event) => selectDevice(event.target.value)} disabled={captureState === 'saving'}>
            <option value="default">系統預設麥克風</option>
            {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
          </select>
        </label>
        <button className="secondary" onClick={() => void refreshDevices()} disabled={captureState === 'saving'}>重新整理裝置</button>
        <div className="meter" aria-label={`目前音量 ${level.toFixed(0)} dBFS`}>
          <div className="meter-label"><span>輸入音量</span><strong>{level.toFixed(0)} dBFS</strong></div>
          <div className="meter-track"><div className="meter-value" style={{ width: `${Math.max(0, Math.min(100, ((level + 60) / 60) * 100))}%` }} /><i style={{ left: `${Math.max(0, Math.min(100, ((peak + 60) / 60) * 100))}%` }} /></div>
        </div>
        <div className="timer">{timestamp(elapsedMs)}</div>
      </section>

      <section className="transcript" aria-live="polite">
        {transcripts.length === 0 ? (
          <div className="empty"><h2>等待語音</h2><p>開始收音後，原文與翻譯會顯示在這裡。</p></div>
        ) : transcripts.map((entry) => (
          <article key={entry.id} className={entry.status}>
            <time>{timestamp(entry.startMs)}</time>
            <p>{entry.sourceText}</p>
            {entry.translatedText && <p className="translation">{entry.translatedText}</p>}
          </article>
        ))}
      </section>

      <div className="export-bar">
        <span>字幕匯出</span>
        <button className="text-button" onClick={() => exportTranscript('txt')}>TXT</button>
        <button className="text-button" onClick={() => exportTranscript('srt')}>SRT</button>
        <button className="text-button" onClick={() => exportTranscript('json')}>JSON</button>
        {window.s2t && <button className="text-button" onClick={toggleFloatingCaptions}>{floatingCaptions ? '隱藏浮動字幕' : '浮動字幕'}</button>}
      </div>
      <footer>
        {canRecord ? <button className="primary" onClick={() => void startCapture()}>開始收音</button> : (
          <>
            {captureState === 'saving' ? (
              <button className="secondary" onClick={forceReleaseCapture}>結束並釋放麥克風</button>
            ) : (
              <>
                <button className="secondary" onClick={() => void togglePause()}>{captureState === 'paused' ? '繼續' : '暫停'}</button>
                <button className="danger" onClick={() => void stopAndSave()}>停止並儲存</button>
              </>
            )}
          </>
        )}
      </footer>
    </>
  )

  const workspace = view === 'live' ? liveWorkspace : view === 'history' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">HISTORY</p><h2>錄音與逐字稿記錄</h2></div><span>{sessions.length} 筆</span></div>
      {sessions.length === 0 ? <div className="empty compact"><h2>還沒有記錄</h2><p>完成一次錄音後，會議資料會出現在這裡。</p></div> : (
        <div className="session-list">{sessions.map((entry) => <article key={entry.id} className="session-item"><div><strong>{entry.title}</strong><p>{new Date(entry.createdAt).toLocaleString('zh-TW')} · {timestamp(entry.durationMs)} · {entry.source}</p></div><button className="secondary" onClick={() => { navigator.clipboard.writeText(entry.transcript).then(() => setStatus('已複製逐字稿')).catch(() => setStatus('無法複製逐字稿')) }}>複製逐字稿</button></article>)}</div>
      )}
    </section>
  ) : view === 'import' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">IMPORT</p><h2>匯入音訊或影片</h2></div></div>
      <label className="drop-zone"><input type="file" accept=".wav,.mp3,.m4a,.aac,.ogg,.webm,.flac,.mp4,.mov" onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} /><strong>選擇檔案</strong><span>支援 WAV、MP3、M4A、AAC、OGG、WebM、FLAC、MP4、MOV，最大 2 GB</span></label>
      {importError && <p className="import-error" role="alert">{importError}</p>}
      {importedFile && <div className="import-result"><strong>{importedFile.name}</strong><span>{(importedFile.size / 1024 / 1024).toFixed(1)} MB · {importedFile.type || '未知格式'}</span><p>檔案已可供自有模型適配器提交。模型端點尚未設定前，不會上傳或處理檔案。</p></div>}
    </section>
  ) : (
    <section className="page-panel settings-panel">
      <div className="page-title"><div><p className="eyebrow">SETTINGS</p><h2>轉錄與模型設定</h2></div></div>
      <label>來源語言<select value={settings.sourceLanguage} onChange={(event) => setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option></select></label>
      <label>目標語言<select value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="en">English</option><option value="zh-TW">繁體中文</option><option value="ja">日本語</option></select></label>
      <label>自有模型端點<input type="url" placeholder="例如 wss://model.example.com/stream" value={settings.modelEndpoint} onChange={(event) => setSettings((current) => ({ ...current, modelEndpoint: event.target.value }))} /></label>
      <p className="hint">端點設定只保存在此裝置。實際傳輸協定與認證方式將在 ModelAdapter 串接時依你的模型介面實作。</p>
      <button className="primary" onClick={saveSettings}>儲存設定</button>{settingsSaved && <span className="saved">已儲存</span>}
    </section>
  )

  if (isFloatingCaptionWindow) {
    return <main className="floating-caption" aria-live="polite"><p>{floatingCaptionText}</p></main>
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">S2T UI</p>
          <h1>即時語音字幕</h1>
        </div>
        <span className={`status ${isActive ? 'active' : ''}`}>{status}</span>
      </header>
      <nav aria-label="主要功能"><button className={view === 'live' ? 'nav-active' : ''} onClick={() => setView('live')}>即時轉錄</button><button className={view === 'history' ? 'nav-active' : ''} onClick={() => setView('history')}>記錄</button><button className={view === 'import' ? 'nav-active' : ''} onClick={() => setView('import')}>匯入檔案</button><button className={view === 'settings' ? 'nav-active' : ''} onClick={() => setView('settings')}>設定</button></nav>
      {workspace}
    </main>
  )
}
