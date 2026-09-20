import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { NoopModelAdapter, WebSocketModelAdapter, type ModelAdapter, type TranscriptEvent } from './model-adapter'
import { synthesizeBreezeTts } from './breeze-tts'

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
  audioKey: string
  segments: TranscriptEvent[]
}
type Settings = {
  sourceLanguage: string
  targetLanguage: string
  modelProfiles: ModelProfile[]
  selectedModelId: string
  ttsEndpoint: string
  ttsInstruction: string
}
type ModelProfile = { id: string; name: string; endpoint: string; kind: 'websocket' }

const sessionsKey = 's2t-ui.sessions.v1'
const settingsKey = 's2t-ui.settings.v1'
const recordingsDatabase = 's2t-ui.recordings.v1'
const recordingsStore = 'audio'

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

const makeTranscriptText = (entries: TranscriptEvent[]): string => entries
  .filter((entry) => entry.status === 'final')
  .map((entry) => `[${timestamp(entry.startMs)}] ${entry.sourceText}${entry.translatedText ? `\n${entry.translatedText}` : ''}`)
  .join('\n\n')

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

const defaultModelProfile: ModelProfile = { id: 'none', name: '未連接模型', endpoint: '', kind: 'websocket' }
const normalizeSettings = (value: Partial<Settings> & { modelEndpoint?: string }): Settings => ({
  sourceLanguage: value.sourceLanguage ?? 'zh-TW',
  targetLanguage: value.targetLanguage ?? 'en',
  modelProfiles: value.modelProfiles?.length ? value.modelProfiles : [{ ...defaultModelProfile, endpoint: value.modelEndpoint ?? '' }],
  selectedModelId: value.selectedModelId ?? value.modelProfiles?.[0]?.id ?? 'none',
  ttsEndpoint: value.ttsEndpoint ?? 'http://127.0.0.1:7860/v1/audio/speech',
  ttsInstruction: value.ttsInstruction ?? ''
})

const browserDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const openRecordingsDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(recordingsDatabase, 1)
  request.onupgradeneeded = () => request.result.createObjectStore(recordingsStore)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const saveRecording = async (key: string, audio: Blob): Promise<void> => {
  const database = await openRecordingsDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(recordingsStore, 'readwrite')
    transaction.objectStore(recordingsStore).put(audio, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

const loadRecording = async (key: string): Promise<Blob | undefined> => {
  const database = await openRecordingsDatabase()
  const audio = await new Promise<Blob | undefined>((resolve, reject) => {
    const request = database.transaction(recordingsStore, 'readonly').objectStore(recordingsStore).get(key)
    request.onsuccess = () => resolve(request.result as Blob | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return audio
}

const makeWav = (chunks: Float32Array[], sampleRate: number): Blob => {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + sampleCount * bytesPerSample)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * bytesPerSample, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * bytesPerSample, true)
  let offset = 44
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const normalized = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true)
      offset += bytesPerSample
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
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
  const [settings, setSettings] = useState<Settings>(() => normalizeSettings(loadJson<Partial<Settings> & { modelEndpoint?: string }>(settingsKey, {})))
  const [importedFile, setImportedFile] = useState<File | null>(null)
  const [importError, setImportError] = useState('')
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [floatingCaptions, setFloatingCaptions] = useState(false)
  const [floatingCaptionText, setFloatingCaptionText] = useState('等待字幕')
  const [playingSessionId, setPlayingSessionId] = useState<string | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [ttsText, setTtsText] = useState('這是 S2T UI 的 Breeze TTS 測試。')
  const [ttsStatus, setTtsStatus] = useState('')
  const [newModelName, setNewModelName] = useState('')

  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const silentGainRef = useRef<GainNode | null>(null)
  const recordingDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const pcmChunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48_000)
  const pausedRef = useRef(false)
  const playbackUrlRef = useRef<string | null>(null)
  const startAtRef = useRef(0)
  const pausedDurationRef = useRef(0)
  const pauseStartedAtRef = useRef<number | null>(null)
  const meterFrameRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const modelRef = useRef<ModelAdapter>(new NoopModelAdapter())
  const unsubscribeModelRef = useRef<(() => void) | null>(null)
  const sampleOffsetRef = useRef(0)
  const activeDeviceIdRef = useRef('default')
  const selectedModel = settings.modelProfiles.find((profile) => profile.id === settings.selectedModelId) ?? defaultModelProfile

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

  const receiveTranscript = useCallback((event: TranscriptEvent): void => {
    setTranscripts((current) => {
      const existing = current.findIndex((entry) => entry.id === event.id)
      if (existing < 0) return [...current, event].sort((a, b) => a.startMs - b.startMs)
      const next = [...current]
      if (event.revision >= next[existing].revision) next[existing] = event
      return next
    })
  }, [])

  useEffect(() => {
    unsubscribeModelRef.current = modelRef.current.onTranscript(receiveTranscript)
    return () => unsubscribeModelRef.current?.()
  }, [receiveTranscript])

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

  useEffect(() => () => {
    cleanUpCapture()
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
  }, [cleanUpCapture])

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

      unsubscribeModelRef.current?.()
      modelRef.current = selectedModel.endpoint.trim()
        ? new WebSocketModelAdapter(selectedModel.endpoint.trim())
        : new NoopModelAdapter()
      unsubscribeModelRef.current = modelRef.current.onTranscript(receiveTranscript)

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
        if (pausedRef.current) return
        pcmChunksRef.current.push(samples)
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

      pcmChunksRef.current = []
      sampleRateRef.current = context.sampleRate
      pausedRef.current = false
      const recorder = new MediaRecorder(recordingDestination.stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined })
      recorderRef.current = recorder
      recorder.start(1000)
      await modelRef.current.start({ sampleRate: context.sampleRate, language: settings.sourceLanguage, targetLanguage: settings.targetLanguage })

      startAtRef.current = Date.now()
      activeDeviceIdRef.current = selectedDeviceId
      pausedDurationRef.current = 0
      setElapsedMs(0)
      timerRef.current = window.setInterval(() => setElapsedMs(Date.now() - startAtRef.current - pausedDurationRef.current), 250)
      setCaptureState('recording')
      setStatus(selectedModel.endpoint.trim() ? `收音中，正在接收「${selectedModel.name}」字幕。` : '收音中。模型尚未接入，字幕會在模型適配器完成後顯示。')
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
      pausedRef.current = true
      pauseStartedAtRef.current = Date.now()
      setCaptureState('paused')
      setStatus('已暫停')
    } else if (captureState === 'paused') {
      recorder.resume()
      pausedRef.current = false
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
      const blob = makeWav(pcmChunksRef.current, sampleRateRef.current)
      const finalSegments = transcripts.filter((entry) => entry.status === 'final')
      const transcript = makeTranscriptText(finalSegments)
      const name = `s2t-${new Date().toISOString().replace(/[:.]/g, '-')}`
      const sessionId = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const source = selectedDeviceId === 'default' ? '系統預設麥克風' : (devices.find((device) => device.deviceId === selectedDeviceId)?.label ?? '已選擇的音源')

      if (window.s2t) {
        const result = await window.s2t.saveSession({ name, audio: await blob.arrayBuffer(), transcript, createdAt, durationMs: elapsedMs, source, segments: finalSegments })
        if (result.canceled) {
          setStatus('已取消儲存')
          return
        }
        setStatus(`已儲存錄音與逐字稿：${result.audioPath}`)
      } else {
        browserDownload(blob, `${name}.wav`)
        browserDownload(new Blob([transcript], { type: 'text/plain;charset=utf-8' }), `${name}.txt`)
        setStatus('已下載錄音與逐字稿')
      }
      try {
        await saveRecording(sessionId, blob)
      } catch {
        setStatus('已儲存錄音與逐字稿；此瀏覽器無法保存歷史音檔。')
      }
      setSessions((current) => [{
        id: sessionId,
        title: name,
        createdAt,
        durationMs: elapsedMs,
        source,
        transcript,
        audioKey: sessionId,
        segments: finalSegments
      }, ...current])
    } catch (error) {
      setStatus(error instanceof Error ? `儲存失敗：${error.message}` : '儲存失敗')
    } finally {
      cleanUpCapture()
      recorderRef.current = null
      pcmChunksRef.current = []
      setCaptureState('idle')
      setLevel(-60)
      setPeak(-60)
    }
  }

  const forceReleaseCapture = (): void => {
    cleanUpCapture()
    recorderRef.current = null
    pcmChunksRef.current = []
    pausedRef.current = false
    setCaptureState('idle')
    setLevel(-60)
    setPeak(-60)
    setStatus('已停止並釋放麥克風；未完成的儲存可能遺失。')
  }

  const exportTranscript = (format: 'txt' | 'srt' | 'json'): void => {
    const name = `s2t-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const content = format === 'srt' ? makeSrt(transcripts) : format === 'json'
      ? JSON.stringify(transcripts.filter((entry) => entry.status === 'final'), null, 2)
      : makeTranscriptText(transcripts)
    browserDownload(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }), `${name}.${format}`)
    setStatus(`已下載 ${format.toUpperCase()} 字幕檔`)
  }

  const saveSettings = (): void => {
    setSettingsSaved(true)
    window.setTimeout(() => setSettingsSaved(false), 2400)
  }

  const addModelProfile = (): void => {
    const name = newModelName.trim()
    if (!name) {
      setStatus('請輸入模型名稱。')
      return
    }
    const profile: ModelProfile = { id: crypto.randomUUID(), name, endpoint: '', kind: 'websocket' }
    setSettings((current) => ({ ...current, modelProfiles: [...current.modelProfiles, profile], selectedModelId: profile.id }))
    setNewModelName('')
  }

  const updateSelectedModel = (update: Partial<ModelProfile>): void => {
    setSettings((current) => ({ ...current, modelProfiles: current.modelProfiles.map((profile) => profile.id === current.selectedModelId ? { ...profile, ...update } : profile) }))
  }

  const removeSelectedModel = (): void => {
    if (selectedModel.id === 'none') return
    setSettings((current) => ({ ...current, modelProfiles: current.modelProfiles.filter((profile) => profile.id !== current.selectedModelId), selectedModelId: 'none' }))
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

  const playSession = async (entry: SavedSession): Promise<void> => {
    try {
      const audio = await loadRecording(entry.audioKey)
      if (!audio) {
        setStatus('找不到此記錄的本機音檔。')
        return
      }
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      const url = URL.createObjectURL(audio)
      playbackUrlRef.current = url
      setPlaybackUrl(url)
      setPlayingSessionId(entry.id)
      setStatus(`正在準備播放：${entry.title}`)
    } catch {
      setStatus('無法讀取此記錄的音檔。')
    }
  }

  const exportSavedTranscript = (entry: SavedSession, format: 'txt' | 'srt' | 'json'): void => {
    const segments = entry.segments ?? []
    const content = format === 'txt' ? entry.transcript : format === 'srt'
      ? makeSrt(segments)
      : JSON.stringify(segments, null, 2)
    if (format !== 'txt' && segments.length === 0) {
      setStatus('此舊記錄沒有時間軸資料，僅能匯出 TXT。')
      return
    }
    browserDownload(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }), `${entry.title}.${format}`)
    setStatus(`已匯出 ${format.toUpperCase()} 逐字稿`)
  }

  const downloadSessionAudio = async (entry: SavedSession): Promise<void> => {
    try {
      const audio = await loadRecording(entry.audioKey)
      if (!audio) throw new Error('找不到本機音檔')
      browserDownload(audio, `${entry.title}.wav`)
      setStatus('已下載 WAV 錄音')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '無法下載錄音')
    }
  }

  const testBreezeTts = async (): Promise<void> => {
    if (!settings.ttsEndpoint.trim() || !ttsText.trim()) {
      setTtsStatus('請輸入 Breeze API 位址與要朗讀的文字。')
      return
    }
    setTtsStatus('正在請求 Breeze TTS…')
    try {
      const audio = await synthesizeBreezeTts({
        endpoint: settings.ttsEndpoint.trim(), text: ttsText.trim(), instruction: settings.ttsInstruction, cfgScale: 4
      })
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      const url = URL.createObjectURL(audio)
      playbackUrlRef.current = url
      setPlaybackUrl(url)
      setPlayingSessionId('breeze-test')
      setTtsStatus('Breeze TTS 已產生音訊。')
    } catch (error) {
      setTtsStatus(error instanceof Error ? `Breeze TTS 失敗：${error.message}` : 'Breeze TTS 失敗。')
    }
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
        <div className="session-list">{sessions.map((entry) => <article key={entry.id} className="session-item"><div><strong>{entry.title}</strong><p>{new Date(entry.createdAt).toLocaleString('zh-TW')} · {timestamp(entry.durationMs)} · {entry.source}</p>{playingSessionId === entry.id && playbackUrl && <audio controls autoPlay src={playbackUrl}>此瀏覽器不支援音訊播放。</audio>}</div><div className="session-actions"><button className="secondary" onClick={() => void playSession(entry)}>播放錄音</button><button className="secondary" onClick={() => void downloadSessionAudio(entry)}>下載 WAV</button><button className="secondary" onClick={() => exportSavedTranscript(entry, 'txt')}>下載逐字稿</button><button className="text-button" onClick={() => exportSavedTranscript(entry, 'srt')}>SRT</button><button className="text-button" onClick={() => exportSavedTranscript(entry, 'json')}>JSON</button></div></article>)}</div>
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
      <label>來源語言<select value={settings.sourceLanguage} onChange={(event) => setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="nan-TW">台語</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option></select></label>
      <label>目標語言<select value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="en">English</option><option value="zh-TW">繁體中文</option><option value="ja">日本語</option></select></label>
      <div className="model-settings">
        <p className="eyebrow">字幕／翻譯模型</p>
        <label>目前模型<select value={settings.selectedModelId} onChange={(event) => setSettings((current) => ({ ...current, selectedModelId: event.target.value }))}>{settings.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>模型名稱<input value={selectedModel.name} disabled={selectedModel.id === 'none'} onChange={(event) => updateSelectedModel({ name: event.target.value })} /></label>
        <label>WebSocket 端點<input type="url" placeholder="wss://model.example.com/stream" disabled={selectedModel.id === 'none'} value={selectedModel.endpoint} onChange={(event) => updateSelectedModel({ endpoint: event.target.value })} /></label>
        <p className="hint">模型必須符合 [ModelAdapter](docs/MODEL_ADAPTER.md) 的音訊 frame 協定，並由你的 gateway 合併 ASR 與翻譯回應。</p>
        <div className="model-actions"><input value={newModelName} placeholder="新模型名稱" onChange={(event) => setNewModelName(event.target.value)} /><button className="secondary" onClick={addModelProfile}>新增模型</button>{selectedModel.id !== 'none' && <button className="danger" onClick={removeSelectedModel}>刪除此模型</button>}</div>
      </div>
      <div className="tts-settings">
        <p className="eyebrow">BREEZE TTS 2</p>
        <label>API 位址<input type="url" value={settings.ttsEndpoint} onChange={(event) => setSettings((current) => ({ ...current, ttsEndpoint: event.target.value }))} /></label>
        <label>語音指令（選填）<input value={settings.ttsInstruction} placeholder="例如：以清晰、平穩的中文語氣朗讀" onChange={(event) => setSettings((current) => ({ ...current, ttsInstruction: event.target.value }))} /></label>
        <label>測試文字<textarea value={ttsText} onChange={(event) => setTtsText(event.target.value)} /></label>
        <button className="secondary" onClick={() => void testBreezeTts()}>測試並播放 Breeze TTS</button>
        {ttsStatus && <p className="hint">{ttsStatus}</p>}
        {playingSessionId === 'breeze-test' && playbackUrl && <audio controls autoPlay src={playbackUrl}>此瀏覽器不支援音訊播放。</audio>}
      </div>
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
