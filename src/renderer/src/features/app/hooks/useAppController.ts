import { orderedWindow } from '../../../shared/services/ordered-window'
import { prompt, setPromptCatalog } from '../../../shared/services/prompts'
import type { ComparisonKind } from '../../quality-comparison/domain/comparison'
import { createTextSearch } from '../../../shared/services/search'
import { searchCaptionGroups } from '../../transcript/domain/search'
import { createSessionSyncCoordinator, type SessionSyncCoordinator, type SessionConflict } from '../../sessions/services/sync-coordinator'
import { requestEpoch } from '../../../shared/http/authenticated-client'
import { startRecordingCheckpoints } from '../../capture/recording/checkpoint'
import { createRecordingRecoveryStore } from '../../capture/recording/adapters/recovery-store'
import { recoverRecordings } from '../../sessions/services/recover-recordings'
import type { PcmSink } from '../../capture/recording/ports'
import { createDesktopPcmSink, createBrowserPcmSink } from '../../capture/recording/adapters/pcm-sinks'
import { translateSessionSummary } from '../../summary/services/translate-summary'
import { createTextPort } from '../../translation/transports/create-text-port'
import { summarizeTranscript as summarizeTranscriptWorkflow } from '../../summary/services/summarize-transcript'
import { createSessionOutbox } from '../../sessions/services/session-outbox'
import { sessionHistory } from '../../sessions/domain/history'
import { retrySession } from '../../sessions/services/recovery-handlers'
import { correctionGroups, correctedCaption, applySentenceCorrection, CorrectionAudioBuffer } from '../../transcript/services/quality-correction'
import { sessionStorageStatesForSnapshot } from '../../sessions/domain/storage-state'
import { createSummaryPort } from '../../summary/transports/create-summary-port'
import { registerCaptionTiming, setCaptionMeasurementActive } from '../../../shared/services/caption-metrics'
import { applyEnvironmentSettings } from '../../settings/domain/environment-settings'
import { importExtensions } from '../../transcript/import-formats'
import { openCaptionPopout, type CaptionPopout } from '../../captions/services/popout'
import { type CaptureState, type AudioDevice, type View, type SavedSession, type Settings, type ModelProfile, type ModelCapabilities, type TextModelProfile, type AudioVersion, type CaptureModelSnapshot } from '../../../shared/types'
import { dbfs, meterPercent, makeWav, pcm16 } from '../../../shared/services/audio'
import { BufferedPcmWriter, pcmRecordingBufferLimits } from '../../capture/recording/buffered-writer'
import { makeVtt, makeTranscriptText, makeTranscriptCsv, timestamp } from '../../../shared/services/transcript'
import { modelEndpoint, defaultWebSocketCapabilities, defaultHttpCapabilities, defaultModelProfile, languageName, normalizeSettings, initialSettings, asrLanguage } from '../../../shared/services/settings'
import { speedToVadConfig } from '../../capture/vad'
import { HttpServiceError, readJsonResponse } from '../../../shared/services/http'
import { browserDownload } from '../../../shared/services/download'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { NoopModelAdapter, OpenAiChunkedModelAdapter, createOpenAiChunkedModelAdapter, WebSocketModelAdapter, type ModelAdapter, type TranscriptEvent } from '../../models/model-adapter'
import { assignSpeakersByOverlap, parseSpeakerEmbeddings, parseSpeakerTurns, stabilizeSpeakerTurns, type SpeakerTurn } from '../../speakers/diarization'
import { voiceprintStorage, type Voiceprint } from '../../speakers/services/voiceprint-storage'
import { readPcmWavSentence, joinOverlappedText, nextPcmWavChunkStart, pcmWavChunkCount, readPcmWavFileChunk, readPcmWavFileLayout } from '../../transcript/wav-batch'
import { importFileFingerprint, importModelSnapshot, matchesImportCheckpoint } from '../../transcript/import-checkpoint'
import { StreamingResampler, chooseModelSampleRate } from '../../capture/resample'
import { remoteSessionStorage } from '../../sessions/services/remote-session-storage'
import { downloadTranscriptBlob, transcriptBlob, type TranscriptDownloadFormat } from '../../transcript/services/documents'
import { encodeM4a, type AudioDownloadFormat } from '../../capture/services/audio-export'
import { mergeSessions, recoverStaleProcessing, rebaseSessions, SessionMergeConflictError } from '../../sessions/domain/session-merge'
import { resolveTranslationTarget, shouldSkipTranslation, throttledTranslationDelayMs, translationAggregationDelayMs } from '../../translation/domain/policy'
import { TranslationQueue, type TranslateCaption } from '../../translation/services/queue'
import { groupLiveCaptions, upsertLiveCaption, renderedLiveCaptionWindow, editCaptionContent, completedCaptionGroups, freezeCaptionGroups, captionGroupSignature } from '../../transcript/domain/live-caption'
import { transcriptSignature } from '../../summary/domain/plan'
import { revertSummaryPreview } from '../../summary/domain/summary-preview'
import { authFetch, retryableAuthFetch } from '../../auth/services/auth-client'
import { activeTranslate, interfaceTranslate, resolveUiLanguage } from '../../../shared/i18n'
import { RemotePcmRecording } from '../../capture/recording/adapters/remote-pcm-recording'
import { OpfsPcmRecording } from '../../capture/recording/adapters/opfs-pcm-recording'

// Browsers without OPFS retain the fallback PCM in RAM until it can be made
// into a WAV. Keep that fallback bounded; OPFS and Electron stream to disk.
const maximumMemoryRecordingBytes = 256 * 1024 * 1024
const browserAsrTimeoutMs = 120_000
const headerValue = (value: string): string => encodeURIComponent(value)
const maximumGeneratedSessionTitleLength = 's2t-YYYY-MM-DDTHH-MM-SS-sssZ'.length

const requestBrowserAsr = async (init: RequestInit, controller = new AbortController()): Promise<Response> => {
  const timeout = window.setTimeout(() => controller.abort(), browserAsrTimeoutMs)
  try { return await authFetch('/api/transcriptions', { ...init, headers: { ...init.headers, 'x-s2t-workload': 'background' }, signal: controller.signal }) }
  finally { window.clearTimeout(timeout) }
}

const automaticSessionTitle = (_transcript: string, createdAt = new Date().toISOString()): string => {
  return `s2t-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}`
}

const remoteSettingsPayload = (settings: Settings): Record<string, unknown> => {
  const { glossary: _glossary, summaryTemplate: _summaryTemplate, summaryTemplates: _summaryTemplates, selectedSummaryTemplateId: _selectedSummaryTemplateId, ...persisted } = settings
  return persisted
}

type CaptureAudioChoice = { deviceId: string; systemEnabled: boolean }

export function useAppController(userId: string, userRole: 'admin' | 'developer' | 'user' = 'user') {
const isFloatingCaptionWindow = window.location.hash === '#floating'
const viewFromLocation = (): View => {
  const candidate = window.location.protocol === 'file:' ? window.location.hash.replace(/^#\/?/, '') : window.location.pathname.replace(/^\//, '')
  return (['live', 'history', 'quality-comparison', 'summary', 'import', 'models', 'voiceprints', 'settings'] as const).includes(candidate as View) ? candidate as View : 'live'
}

const [devices, setDevices] = useState<AudioDevice[]>([])

const [selectedDeviceId, setSelectedDeviceId] = useState('default')

const [includeSystemAudio, setIncludeSystemAudio] = useState(false)

const [captureState, setCaptureState] = useState<CaptureState>('idle')
const [preparingContinuation, setPreparingContinuation] = useState(false)
const preparingContinuationRef = useRef(false)

const [microphoneLevel, setMicrophoneLevel] = useState(-60)

const [systemLevel, setSystemLevel] = useState(-60)

const [elapsedMs, setElapsedMs] = useState(0)
const [captionTimerOffsetMs, setCaptionTimerOffsetMs] = useState(0)
const translationElapsedMsRef = useRef(elapsedMs)
translationElapsedMsRef.current = elapsedMs

const detectTranscriptLanguage = (text: string): TranscriptEvent['detectedLanguage'] => {
  if (/[ぁ-んァ-ヶ]/.test(text)) return 'ja-JP'
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-TW'
  if (/[äöüß]/i.test(text)) return 'de-DE'
  return 'en-US'
}

const [transcripts, storeTranscripts] = useState<TranscriptEvent[]>([])

const transcriptsRef = useRef<TranscriptEvent[]>([])
const [sessions, storeSessions] = useState<SavedSession[]>([])
const sessionsRef = useRef<SavedSession[]>([])
const sessionsHydratedRef = useRef(false)
const sessionSyncRef = useRef<SessionSyncCoordinator | null>(null)
const sessionOwnerActiveRef = useRef(true)
const setSessions = useCallback((update: SavedSession[] | ((current: SavedSession[]) => SavedSession[])): void => {
  const next = typeof update === 'function' ? update(sessionsRef.current) : update
  sessionsRef.current = next
  if (sessionsHydratedRef.current && sessionOwnerActiveRef.current && !window.s2t) sessionSyncRef.current?.record(next)
  storeSessions(next)
}, [])
const [qualityCorrectionProgress, setQualityCorrectionProgress] = useState<Record<string, {
  stage: 'loading' | 'asr' | 'diarization' | 'translation' | 'completed' | 'failed'; completed: number; total: number; error?: string
}>>({})
const liveCorrectionAudioRef = useRef<CorrectionAudioBuffer | null>(null)
const liveCorrectionEpochRef = useRef(0)
const liveCorrectionBusyRef = useRef(false)
const liveCorrectionDoneRef = useRef(new Set<string>())
const liveCorrectionFailuresRef = useRef(new Map<string, number>())
const liveCorrectionRunnerRef = useRef<() => Promise<void>>(async () => {})
const qualityCorrectionActiveRef = useRef(new Set<string>())
const recoveryActiveRef = useRef(new Set<string>())
const titleActiveRef = useRef(new Set<string>())
const [titleGeneratingIds, setTitleGeneratingIds] = useState<string[]>([])
const savedLiveSnapshotRef = useRef<TranscriptEvent[] | null>(null)
const finishingSessionRef = useRef<{ id: string; token: string } | null>(null)

const setTranscripts = useCallback((update: TranscriptEvent[] | ((current: TranscriptEvent[]) => TranscriptEvent[])): void => {
    const next = typeof update === 'function' ? update(transcriptsRef.current) : update
    transcriptsRef.current = next
    storeTranscripts(next)
    const finishing = finishingSessionRef.current
    if (finishing) {
      const segments = next.filter((entry) => entry.status !== 'partial')
      setSessions((current) => current.map((entry) => entry.id === finishing.id && entry.processingToken === finishing.token
        ? { ...entry, segments, transcript: makeTranscriptText(segments) } : entry))
    }
  }, [])

const [clearedThroughMs, setClearedThroughMs] = useState(-1)

const clearBoundaryRef = useRef(-1)

const [followingCaptions, setFollowingCaptions] = useState(true)

const [viewingSessionId, setViewingSessionId] = useState<string | null>(null)

const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)

const [titleDraft, setTitleDraft] = useState('')

const [status, setStatus] = useState(activeTranslate('stReady'))

const [view, setCurrentView] = useState<View>(viewFromLocation)
useLayoutEffect(() => {
  setCaptionMeasurementActive(view === 'live')
  return () => setCaptionMeasurementActive(false)
}, [view])

const setView = useCallback((next: View): void => {
    const route = `/${next}`
    if (window.location.protocol === 'file:') window.location.hash = route
    else if (window.location.pathname !== route) window.history.pushState({}, '', route)
    setCurrentView(next)
  }, [])

const [sessionsHydrated, setSessionsHydrated] = useState(false)
const diarizationPollKey = JSON.stringify(sessions.filter((entry) => entry.processingState === 'running' && entry.processingStage === 'diarization' && entry.diarizationJobId).map((entry) => ({ id: entry.id, token: entry.processingToken, jobId: entry.diarizationJobId })))
useEffect(() => {
  if (window.s2t) return
  const jobs: Array<{ id: string; token?: string; jobId: string }> = JSON.parse(diarizationPollKey)
  if (!jobs.length) return
  let disposed = false
  let timer: number | undefined
  const controller = new AbortController()
  const poll = async (): Promise<void> => {
    for (const job of jobs) {
      if (disposed) return
      try {
        const result = await readJsonResponse<{ job?: { state?: string; error?: string } }>(await authFetch(`/api/data/diarization-jobs?id=${encodeURIComponent(job.jobId)}`, { signal: controller.signal }), activeTranslate('stFinalDiarizationJobStatus'))
        if (disposed) return
        if (result.job?.state === 'completed') {
          const remote = await remoteSessionStorage.load()
          if (disposed) return
          const finished = remote.sessions.find((entry) => entry.id === job.id && entry.processingToken === job.token)
          if (finished) {
            setSessions((current) => current.map((entry) => entry.id === job.id && entry.processingToken === job.token
              ? { ...finished, processingState: finished.processingError || finished.processingFailures?.length ? 'failed' : 'completed', processingStage: undefined } : entry))
          } else {
            // The job answered but the record it belongs to was removed or
            // replaced by another tab. Leaving the poller running would
            // re-download every session every two seconds forever, and the
            // record can no longer be updated either way.
            setSessions((current) => current.map((entry) => entry.id === job.id && entry.processingToken === job.token
              ? { ...entry, processingState: 'failed', processingStage: undefined, processingError: activeTranslate('stBackgroundDiarizationRecordReplaced') } : entry))
          }
        } else if (result.job?.state === 'failed') {
          setSessions((current) => current.map((entry) => entry.id === job.id && entry.processingToken === job.token
            ? { ...entry, processingState: 'failed', processingStage: undefined, processingFailures: [...new Set([...(entry.processingFailures || []), 'diarization' as const])], processingError: result.job?.error || activeTranslate('stFinalDiarizationJobFailed') } : entry))
        }
      } catch (error) {
        // Only failures a retry can still resolve stay pending. A job row that
        // no longer exists would otherwise keep this record `running` — and
        // therefore unactionable — for as long as the tab stays open.
        if (error instanceof HttpServiceError && error.status === 404 && !disposed) {
          setSessions((current) => current.map((entry) => entry.id === job.id && entry.processingToken === job.token
            ? { ...entry, processingState: 'failed', processingStage: undefined, processingFailures: [...new Set([...(entry.processingFailures || []), 'diarization' as const])], processingError: activeTranslate('stBackgroundDiarizationJobGone') } : entry))
          continue
        }
        /* A transient connection failure retains the durable job and is retried. */
      }
    }
    if (!disposed) timer = window.setTimeout(() => void poll(), 2_000)
  }
  void poll()
  return () => { disposed = true; controller.abort(); if (timer !== undefined) window.clearTimeout(timer) }
}, [diarizationPollKey])

const [sessionStorageStates, setSessionStorageStates] = useState<Record<string, 'local' | 'remote' | 'both' | 'pending'>>({})

const liveAsrSettingsSignatureRef = useRef('')

const continuationTargetRef = useRef<{ entry: SavedSession; audio: Blob; baseDurationMs: number } | null>(null)
const continuationEventIdsRef = useRef(new Map<string, string>())
// The history record currently being edited in the live workspace. It lets a
// history switch persist edits back to that record instead of making a copy.
const liveSessionIdRef = useRef<string | null>(null)
const liveDraftRef = useRef<{ id: string; startedAt: string } | null>(null)
// Capture-time configuration must not be inferred from mutable settings when
// the session is finally saved.
const activeModelSnapshotRef = useRef<CaptureModelSnapshot | null>(null)

const glossaryVersionRef = useRef<number | null>(null)
const summaryTemplateVersionRef = useRef<number | null>(null)
const summaryTemplateSaveRef = useRef<Promise<void>>(Promise.resolve())
const remoteSettingsVersionRef = useRef<number | null>(null)
// The model catalog is deliberately separate from general UI settings.  It is
// account-scoped on the gateway and can be updated by another browser tab.
const modelRegistryVersionRef = useRef<number | null>(null)
const environmentConfigRef = useRef<EnvironmentModels>({})
const accountServiceModelsRef = useRef<Array<{ id: string; name: string; endpoint: string; model: string; purpose: string; requiresApiKey?: boolean; capabilities?: ModelCapabilities }>>([])
const modelRegistrySignatureRef = useRef<string | null>(null)

const [settings, setSettings] = useState<Settings>(() => initialSettings())
const [remoteSettingsHydrated, setRemoteSettingsHydrated] = useState(false)
const [productTitleImage, setProductTitleImage] = useState('')
const [environmentModelsHydrated, setEnvironmentModelsHydrated] = useState(false)

const [importedFile, setImportedFile] = useState<File | null>(null)

const [importError, setImportError] = useState('')

const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)

const [settingsSaved, setSettingsSaved] = useState(false)
const [browserRecordingStorage, setBrowserRecordingStorage] = useState<'opfs' | 'memory' | 'electron'>('memory')
const [remoteSessionSyncState, setRemoteSessionSyncState] = useState<'ready' | 'syncing' | 'paused'>('syncing')
const [remoteSessionConflicts, setRemoteSessionConflicts] = useState<Array<{ id: string; local?: SavedSession; remote?: SavedSession }>>([])
const [summaryTemplatesHydrated, setSummaryTemplatesHydrated] = useState(false)
const [denoiseApplied, setDenoiseApplied] = useState<boolean | null>(null)
const [storageHealth, setStorageHealth] = useState<{ mode: { blob: string; config: string; vector: string }; schemaVersion: string; ready: boolean } | null>(null)
const [audioMigrationStatus, setAudioMigrationStatus] = useState<{ copied: number; pending: number } | null>(null)
const [storageCompensations, setStorageCompensations] = useState<{ audioPending: number; voiceprintPending: number } | null>(null)
const [storageOrphanAudio, setStorageOrphanAudio] = useState<number | null>(null)

const [floatingCaptions, setFloatingCaptions] = useState(false)

const [floatingCaptionText, setFloatingCaptionText] = useState(activeTranslate('waitingForCaptions'))

const [floatingCaptionFullscreen, setFloatingCaptionFullscreen] = useState(false)

const [webCaptionPopup, setWebCaptionPopup] = useState(false)
const [webCaptionWindow, setWebCaptionWindow] = useState<Window | null>(null)
const [webCaptionIsPip, setWebCaptionIsPip] = useState(false)
const [webCaptionPortalRoot, setWebCaptionPortalRoot] = useState<HTMLElement | null>(null)
const captionPopoutRef = useRef<CaptionPopout | null>(null)
const captionPopoutOpeningRef = useRef(false)
const captionPopoutGenerationRef = useRef(0)

const [webCaptionFullscreen, setWebCaptionFullscreen] = useState(false)
const [webCaptionFullscreenError, setWebCaptionFullscreenError] = useState('')

const [captionScale, setCaptionScale] = useState(1)

const [playingSessionId, setPlayingSessionId] = useState<string | null>(null)

const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)

const [newModelName, setNewModelName] = useState('')

const [newModelEndpoint, setNewModelEndpoint] = useState('')

const [newModelId, setNewModelId] = useState('')

const [newModelApiKey, setNewModelApiKey] = useState('')
const [newModelRequiresApiKey, setNewModelRequiresApiKey] = useState(true)

const [newModelUsesBuiltin, setNewModelUsesBuiltin] = useState(false)

const [apiKeyDraft, setApiKeyDraft] = useState('')

const [apiKeyStatus, setApiKeyStatus] = useState('')

const [translationKeyDraft, setTranslationKeyDraft] = useState('')

const [summaryKeyDraft, setSummaryKeyDraft] = useState('')

const [diarizationKeyDraft, setDiarizationKeyDraft] = useState('')

const [voiceprintFile, setVoiceprintFile] = useState<File | null>(null)

const [voiceprintSharingScope, setVoiceprintSharingScope] = useState<Voiceprint['sharingScope']>('private')
const [voiceprintSharingConsent, setVoiceprintSharingConsent] = useState(false)

const [voiceprints, setVoiceprints] = useState<Voiceprint[]>([])

const [voiceprintCaptureState, setVoiceprintCaptureState] = useState<'idle' | 'recording'>('idle')
const [voiceprintLevel, setVoiceprintLevel] = useState(-60)

const [segmentRerecordingId, setSegmentRerecordingId] = useState<string | null>(null)

const [transcriptSearch, setTranscriptSearch] = useState('')

const [editingTranscriptId, setEditingTranscriptId] = useState<string | null>(null)

const [drawer, setDrawer] = useState<'settings' | 'export' | null>('settings')

useEffect(() => { if (view !== 'live') setDrawer(null) }, [view])

const [historyPageSize, setHistoryPageSize] = useState(10)

const [historyPage, setHistoryPage] = useState(1)

const [historySort, setHistorySort] = useState<'title' | 'createdAt' | 'durationMs'>('createdAt')

const [historySortDirection, setHistorySortDirection] = useState<'asc' | 'desc'>('desc')

const [historySearch, setHistorySearch] = useState('')

const [sessionTranscriptSearch, setSessionTranscriptSearch] = useState('')

const [summaryText, setSummaryText] = useState('')

const [summaryStatus, setSummaryStatus] = useState('')

const [modelFilter, setModelFilter] = useState<'all' | 'asr' | 'translation' | 'summary' | 'diarization' | 'others'>('all')
const [modelHealth, setModelHealth] = useState<Record<string, { state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; reason: string; checkedAt: number }>>({})
// Silero VAD model availability on the Web gateway CPU worker. `null` means the
// status check has not answered yet, so the enable checkbox stays hidden.
const [sileroVadAvailable, setSileroVadAvailable] = useState<boolean | null>(null)

const modelHealthRequestRef = useRef(0)
const acceptModelApiTestResult = useCallback((result: { id: string; state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; reason: string; checkedAt: number }): void => {
  modelHealthRequestRef.current++
  setModelHealth(current => ({ ...current, [result.id]: result }))
}, [])
const refreshModelHealth = useCallback(async (): Promise<void> => {
  const request = ++modelHealthRequestRef.current
  try {
    const response = await authFetch('/api/data/model-health', { method: 'POST' })
    const payload = await response.json().catch(() => ({})) as { health?: Array<{ id?: unknown; state?: unknown; reason?: unknown; checkedAt?: unknown }>; error?: string }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    const next: Record<string, { state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; reason: string; checkedAt: number }> = {}
    for (const item of payload.health ?? []) {
      if (typeof item.id !== 'string' || !['healthy', 'degraded', 'unhealthy', 'unknown'].includes(String(item.state))) continue
      next[item.id] = { state: item.state as 'healthy' | 'degraded' | 'unhealthy' | 'unknown', reason: typeof item.reason === 'string' ? item.reason : activeTranslate('stNotConfirmed'), checkedAt: typeof item.checkedAt === 'number' ? item.checkedAt : Date.now() }
    }
    if (request === modelHealthRequestRef.current) setModelHealth(next)
  } catch (error) {
    if (request !== modelHealthRequestRef.current) return
    const reason = error instanceof Error ? activeTranslate('stModelHealthCheckFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stModelHealthCheckFailed')
    // A failed refresh cannot leave an old healthy badge looking current, but it
    // must not erase what was known either — carrying the previous verdict
    // forward is what lets an operator tell a gateway blip from a model that
    // has never answered.
    const label = (state: string): string => activeTranslate(state === 'healthy' ? 'modelHealthHealthy' : state === 'degraded' ? 'modelHealthDegraded' : state === 'unhealthy' ? 'modelHealthFailed' : 'modelHealthUnknown')
    setModelHealth(current => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, { state: 'unknown' as const, reason: `${reason}；${activeTranslate('modelHealthLastKnown').replace('{state}', label(value.state))}`, checkedAt: Date.now() }])))
    setStatus(reason)
  }
}, [])

const streamRef = useRef<MediaStream | null>(null)

const contextRef = useRef<AudioContext | null>(null)

const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

const systemStreamRef = useRef<MediaStream | null>(null)

const systemSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

const microphoneAnalyserRef = useRef<AnalyserNode | null>(null)

const systemAnalyserRef = useRef<AnalyserNode | null>(null)

const meterSinkGainRef = useRef<GainNode | null>(null)

const audioWorkletRef = useRef<AudioWorkletNode | null>(null)

const silentGainRef = useRef<GainNode | null>(null)

const recordingDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null)

const recorderRef = useRef<MediaRecorder | null>(null)

const pcmChunksRef = useRef<Float32Array[]>([])
const memoryRecordingBytesRef = useRef(0)
const memoryRecordingLimitReachedRef = useRef(false)
const remotePcmRecordingRef = useRef<RemotePcmRecording | null>(null)
const opfsRecordingRef = useRef<OpfsPcmRecording | null>(null)
const opfsRecordingIdRef = useRef<string | null>(null)

// Electron streams the durable WAV to the main process, so it cannot reuse
// the browser's full PCM array for live diarization. Keep only a bounded
// rolling window for that preview path.
const liveDiarizationChunksRef = useRef<Float32Array[]>([])
const liveDiarizationHeadRef = useRef(0)
const liveDiarizationStartSampleRef = useRef(0)
const liveDiarizationSamplesRef = useRef(0)
const liveSpeakerTurnsRef = useRef<SpeakerTurn[]>([])
// One voiceprint per STABLE label, fed by whichever window's labels landed on
// it. Without this the voice term could never outvote a sliding window: it is
// the only memory that survives the window moving on.
const liveSpeakerCentroidsRef = useRef(new Map<string, number[]>())

const pcmSinkRef = useRef<PcmSink | null>(null)
const pcmWriterRef = useRef<BufferedPcmWriter | null>(null)

const pcmWriterPausedRef = useRef(false)

const pcmWriterFailedRef = useRef(false)

const electronRecordingIdRef = useRef<string | null>(null)

const sampleRateRef = useRef(48_000)

const pausedRef = useRef(false)

const playbackUrlRef = useRef<string | null>(null)

const startAtRef = useRef(0)

const pausedDurationRef = useRef(0)

const pauseStartedAtRef = useRef<number | null>(null)

const meterFrameRef = useRef<number | null>(null)

const microphoneMeterValueRef = useRef<HTMLDivElement | null>(null)

const systemMeterValueRef = useRef<HTMLDivElement | null>(null)

const meterLastUiUpdateRef = useRef(0)

const timerRef = useRef<number | null>(null)

const modelRef = useRef<ModelAdapter>(new NoopModelAdapter())

const unsubscribeModelRef = useRef<(() => void) | null>(null)

const unsubscribeModelErrorRef = useRef<(() => void) | null>(null)

const sampleOffsetRef = useRef(0)

// sampleOffsetRef counts samples delivered to the ASR model. It may differ
// from the native recording rate when the capture branch resamples audio.
const modelSampleRateRef = useRef(48_000)

const resamplerRef = useRef<StreamingResampler | null>(null)

const activeDeviceIdRef = useRef('default')

const translationQueueRef = useRef<TranslationQueue | null>(null)
if (!translationQueueRef.current) translationQueueRef.current = new TranslationQueue(
  () => transcriptsRef.current, setTranscripts, setStatus
)
const translationTransportRef = useRef<TranslateCaption | null>(null)

// A newer request for the same saved session wins. This prevents a slow first
// request from replacing a manually requested regeneration.
const summaryGenerationRef = useRef(new Map<string, number>())
type SummaryRequest = { generation: number; controller: AbortController; owner: number; userId: string; transcriptSignature: string; sourceVersionId?: string; /** Last fragment this request streamed onto the record, if any. */ preview?: string; previous: Pick<SavedSession, 'summary' | 'summaryState' | 'summaryError' | 'summarySourceSignature' | 'summarySourceVersionId' | 'summaryTranslation' | 'summaryTranslationTargetLanguage'> }
const summaryRequestsRef = useRef(new Map<string, SummaryRequest>())
/** A request that ends without committing rolls its streaming preview back; a
 *  newer request already owning the record must be left alone. */
const rollbackSummaryPreview = (sessionId: string, request: SummaryRequest): void => {
    const owner = summaryRequestsRef.current.get(sessionId)
    if (owner !== undefined && owner !== request) return
    setSessions(current => current.map(entry => entry.id === sessionId ? revertSummaryPreview(entry, request) : entry))
  }
const [summaryGeneratingIds, setSummaryGeneratingIds] = useState<string[]>([])

useEffect(() => () => {
  for (const request of summaryRequestsRef.current.values()) request.controller.abort()
  summaryRequestsRef.current.clear()
}, [userId])

const cancelImportRef = useRef(false)

const importAbortRef = useRef<AbortController | null>(null)
const importRequestsRef = useRef(new Set<AbortController>())

const liveDiarizationRunningRef = useRef(false)
const liveDiarizationGroupsRef = useRef(new Map<string, string>())
const liveDiarizationRetryAtRef = useRef(0)

const transcriptContainerRef = useRef<HTMLElement | null>(null)

const webCaptionPopupRef = useRef<HTMLDivElement | null>(null)

const voiceprintStreamRef = useRef<MediaStream | null>(null)

const voiceprintContextRef = useRef<AudioContext | null>(null)

const voiceprintSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

const voiceprintProcessorRef = useRef<ScriptProcessorNode | null>(null)

const voiceprintSinkRef = useRef<GainNode | null>(null)

const voiceprintChunksRef = useRef<Float32Array[]>([])

const segmentRerecordRef = useRef<{ entry: SavedSession; segment: TranscriptEvent; stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode; sink: GainNode; chunks: Float32Array[] } | null>(null)

// Prefer the explicit selection; when it is missing or no longer valid fall
// back to the environment-provided model (env/gateway profiles are kept at the
// front of the list) before the built-in placeholder.
const selectedModel = settings.modelProfiles.find((profile) => profile.id === settings.selectedModelId)
  ?? settings.modelProfiles.find((profile) => profile.id === 'environment-asr' || profile.id === 'web-environment-asr' || profile.id.startsWith('web-gateway-asr-'))
  ?? defaultModelProfile
// Browser clients may select only an ID published by the gateway. Endpoint and
// credentials remain server-side; this ID is the sole model-routing input.
const gatewayAsrProfileId = (modelId: string): string | null => !window.s2t
  ? modelId === 'web-environment-asr'
    ? 'default'
    : modelId.startsWith('web-gateway-asr-')
      ? modelId.slice('web-gateway-asr-'.length)
      : modelId === 'none' ? null : modelId
  : null
const webGatewayAsrProfileId = gatewayAsrProfileId(selectedModel.id)

const refreshDevices = useCallback(async () => {
    const found = await navigator.mediaDevices.enumerateDevices()
    const inputs = found
      .filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default')
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || activeTranslate('stAudioInputN').replace('{index}', String(index + 1)) }))
    setDevices(inputs)
  }, [])

useEffect(() => {
    const onDeviceChange = (): void => {
      void refreshDevices()
      if (streamRef.current?.getAudioTracks().some((track) => track.readyState === 'ended')) {
        setStatus(activeTranslate('stCurrentSourceRemoved'))
      }
    }
    void refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
}, [refreshDevices])

useEffect(() => {
    const update = (): void => setCurrentView(viewFromLocation())
    window.addEventListener('popstate', update)
    window.addEventListener('hashchange', update)
    return () => { window.removeEventListener('popstate', update); window.removeEventListener('hashchange', update) }
  }, [])

const receiveTranscript = useCallback((event: TranscriptEvent): void => {
    const timedEvent = event
    // Prefer the language returned by ASR. The local character heuristic is
    // only a fallback for providers that do not expose detection metadata.
    if (settings.sourceLanguage === 'auto' && event.sourceText.trim() && !event.detectedLanguage) event = { ...event, detectedLanguage: detectTranscriptLanguage(event.sourceText) }
    const continuation = continuationTargetRef.current
    if (continuation) {
      const id = continuationEventIdsRef.current.get(event.id) ?? `continued-${crypto.randomUUID()}`
      continuationEventIdsRef.current.set(event.id, id)
      event = { ...event, id, startMs: event.startMs + continuation.baseDurationMs, endMs: event.endMs + continuation.baseDurationMs }
    }
    registerCaptionTiming(event.id, timedEvent)
    setTranscripts((current) => {
      const next = upsertLiveCaption(current, event, clearBoundaryRef.current, (id) => translationQueueRef.current!.isActive(id))
      return next
    })
  }, [settings.sourceLanguage])

const adminParameters = userRole !== 'user' ? settings.adminParameters : undefined
const effectiveVadConfig = { ...speedToVadConfig(settings.responseSpeed), ...Object.fromEntries(Object.entries(adminParameters || {}).filter(([key]) => ['minSpeechMs','minSilenceMs','preRollMs','noiseFloorOffsetDb','chunkMinMs','chunkMaxMs'].includes(key))) }
// A partial admin override takes precedence over the response-speed preset.
if (effectiveVadConfig.chunkMinMs > effectiveVadConfig.chunkMaxMs) {
  if (adminParameters?.chunkMaxMs !== undefined) effectiveVadConfig.chunkMinMs = effectiveVadConfig.chunkMaxMs
  else effectiveVadConfig.chunkMaxMs = effectiveVadConfig.chunkMinMs
}
useEffect(() => {
  translationQueueRef.current?.configure({ concurrency: adminParameters?.translationConcurrency, sentenceWaitMs: adminParameters?.translationSentenceWaitMs })
}, [adminParameters?.translationConcurrency, adminParameters?.translationSentenceWaitMs])
const translationReady = settings.translationEnabled && Boolean(settings.translationModel.trim()) && (!window.s2t || Boolean(settings.translationEndpoint.trim()))
const textCompletionPort = useMemo(() => createTextPort({ id: settings.selectedTranslationModelId, endpoint: settings.translationEndpoint, model: settings.translationModel, requiresApiKey: settings.translationProfiles.find(profile => profile.id === settings.selectedTranslationModelId)?.requiresApiKey }), [settings.selectedTranslationModelId, settings.translationEndpoint, settings.translationModel, settings.translationProfiles, userId])
const translateCaption = useCallback<TranslateCaption>((entry, signal, timeoutMs = 15_000, workload = 'realtime') => textCompletionPort.complete({
  workload,
  text: entry.sourceText, sourceLanguage: entry.detectedLanguage || settings.sourceLanguage,
  targetLanguage: resolveTranslationTarget(entry.detectedLanguage, settings.targetLanguage), glossary: settings.glossary,
  temperature: adminParameters?.translationTemperature, signal, timeoutMs
}), [textCompletionPort, settings.sourceLanguage, settings.targetLanguage, settings.glossary, adminParameters?.translationTemperature])
translationTransportRef.current = translateCaption

const requestTranslation = useCallback((entry: TranscriptEvent): Promise<void> => {
    if (!settings.translationModel.trim() || (window.s2t && !settings.translationEndpoint.trim())) {
      setStatus(activeTranslate('stWebTranslationGateway') + ': model not configured')
      return Promise.resolve()
    }
    const group = settings.translationStrategy === 'sentence'
      ? groupLiveCaptions(transcriptsRef.current).find(group => group.members.some(member => member.id === entry.id))
      : undefined
    const requested = group && group.members.every(member => !member.translatedText && member.translationStatus !== 'completed') ? group : entry
    return translationQueueRef.current!.request(requested, translateCaption, settings.targetLanguage)
  }, [translationReady, translateCaption, settings.targetLanguage, settings.translationStrategy])

const cancelPendingTranslations = (): void => {
    translationQueueRef.current!.reset(true)
    setStatus(activeTranslate('stTranslationsCancelled'))
  }

// A request carries the translation settings that were active when it began.
// Invalidate it when those settings change so a late response cannot paint an
// old target language, model, or glossary over the current live caption.
const translationRequestSignature = JSON.stringify({
  enabled: settings.translationEnabled,
  sourceLanguage: settings.sourceLanguage,
  targetLanguage: settings.targetLanguage,
  endpoint: settings.translationEndpoint,
  model: settings.translationModel,
  profileId: settings.selectedTranslationModelId,
  glossary: settings.glossary,
  temperature: adminParameters?.translationTemperature
})
const translationRequestSignatureRef = useRef(translationRequestSignature)

useEffect(() => {
    if (translationRequestSignatureRef.current === translationRequestSignature) return
    const previousTarget = JSON.parse(translationRequestSignatureRef.current).targetLanguage
    translationRequestSignatureRef.current = translationRequestSignature
    if (!finishingSessionRef.current) {
      translationQueueRef.current!.reset()
      if (previousTarget !== settings.targetLanguage) setTranscripts(current => current.map(entry => entry.status === 'final'
        ? { ...entry, translatedText: undefined, translationStatus: undefined, translationAttempts: undefined, translationContentRevision: (entry.translationContentRevision ?? 0) + 1 }
        : entry))
    }
  }, [translationRequestSignature])

useEffect(() => {
    if (!translationReady || settings.translationLoadStrategy === 'manual') return
    const timer = window.setInterval(() => {
      translationQueueRef.current!.tick({ targetLanguage: settings.targetLanguage, strategy: settings.translationStrategy, elapsedMs: translationElapsedMsRef.current },
        translateCaption, settings.translationLoadStrategy === 'throttled')
    }, settings.translationLoadStrategy === 'throttled' ? (adminParameters?.translationThrottledMs ?? throttledTranslationDelayMs) : (adminParameters?.translationAggregationMs ?? translationAggregationDelayMs))
    return () => window.clearInterval(timer)
  }, [translationReady, translateCaption, settings.targetLanguage, settings.translationLoadStrategy, settings.translationStrategy, adminParameters?.translationAggregationMs, adminParameters?.translationThrottledMs])

useEffect(() => () => { translationQueueRef.current!.reset() }, [])

useEffect(() => {
    const signature = JSON.stringify({ language: settings.sourceLanguage, prompt: settings.glossary.trim(), responseSpeed: settings.responseSpeed, vad: effectiveVadConfig })
    if (captureState !== 'recording' && captureState !== 'paused') {
      liveAsrSettingsSignatureRef.current = signature
      return
    }
    if (liveAsrSettingsSignatureRef.current === signature) return
    liveAsrSettingsSignatureRef.current = signature
    if (!modelRef.current.updateLiveSettings) {
      setStatus(activeTranslate('stLiveAsrSettingsUnsupported'))
      return
    }
    modelRef.current.updateLiveSettings({ language: settings.sourceLanguage, prompt: settings.glossary.trim(), vadConfig: effectiveVadConfig, strictChunkLimits: Boolean(adminParameters) })
    if (activeModelSnapshotRef.current) activeModelSnapshotRef.current = { ...activeModelSnapshotRef.current, sourceLanguage: settings.sourceLanguage, prompt: settings.glossary.trim() }
    setStatus(activeTranslate('stLiveAsrSettingsNextChunk'))
  }, [captureState, settings.glossary, settings.sourceLanguage, settings.responseSpeed, settings.adminParameters, userRole])

useEffect(() => {
    const container = transcriptContainerRef.current
    if (!container || !followingCaptions) return
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  }, [transcripts, followingCaptions])

useEffect(() => {
    const active = liveDraftRef.current
    if (window.s2t || !active || (captureState !== 'recording' && captureState !== 'paused')) return
    const owner = requestEpoch(), recording = opfsRecordingRef.current
    return startRecordingCheckpoints({
      isActive: () => owner === requestEpoch() && sessionOwnerActiveRef.current,
      read: () => liveDraftRef.current?.id !== active.id ? undefined : {
        id: active.id, startedAt: active.startedAt, updatedAt: new Date().toISOString(), captureState,
        source: includeSystemAudio ? activeTranslate('stSourceMicAndSystem') : activeTranslate('microphone'),
        elapsedMs: (continuationTargetRef.current?.baseDurationMs ?? 0) + Math.max(0, (pauseStartedAtRef.current ?? Date.now()) - startAtRef.current - pausedDurationRef.current),
        segments: transcriptsRef.current.filter(entry => entry.status !== 'partial'), opfsRecordingId: opfsRecordingIdRef.current ?? undefined, sampleRate: sampleRateRef.current
      },
      local: snapshot => recording?.saveRecoveryDraft(snapshot),
      remote: remoteSessionStorage.saveLiveDraft,
      onError: () => { if (liveDraftRef.current?.id === active.id) setStatus(activeTranslate('stLiveDraftSaveFailed')) },
      clock: window
    })
  }, [captureState, includeSystemAudio, userId])

useEffect(() => {
    if (captureState !== 'recording' || !settings.diarizationModel || !settings.diarizationPreviewEnabled) return
    const timer = window.setInterval(() => {
      const chunks = liveDiarizationChunksRef.current.slice(liveDiarizationHeadRef.current)
      if (liveDiarizationRunningRef.current || chunks.length === 0 || Date.now() < liveDiarizationRetryAtRef.current) return
      const captureId = liveDraftRef.current?.id
      const clipStartMs = (continuationTargetRef.current?.baseDurationMs ?? 0) + liveDiarizationStartSampleRef.current / sampleRateRef.current * 1000
      const frozen = freezeCaptionGroups(transcriptsRef.current)
      if (frozen !== transcriptsRef.current) setTranscripts(frozen)
      const pending = completedCaptionGroups(frozen).filter(group => group.startMs >= clipStartMs &&
        liveDiarizationGroupsRef.current.get(group.id) !== captionGroupSignature(group))
      if (!captureId || !pending.length) return
      const throughMs = Math.max(...pending.map(group => group.endMs))
      const available = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const length = Math.min(available, Math.max(0, Math.round((throughMs - clipStartMs) / 1000 * sampleRateRef.current)))
      if (!length) return
      const completedAudio = new Float32Array(length)
      let offset = 0
      for (const chunk of chunks) {
        const part = chunk.subarray(0, length - offset)
        completedAudio.set(part, offset); offset += part.length
        if (offset === length) break
      }
      const audio = makeWav([completedAudio], sampleRateRef.current)
      liveDiarizationRunningRef.current = true
      void (async () => {
        try {
          const endpoint = window.s2t ? (settings.diarizationEndpoint.trim() || '/api/diarizations') : '/api/diarizations'
          // Only the built-in gateway answers with per-label voiceprints, and a
          // managed remote model never does — so one of these headers, never both.
          const customEndpoint = Boolean(settings.diarizationEndpoint.trim()) && !['/api/diarizations', 's2t-local://diarization'].includes(settings.diarizationEndpoint)
          const previewHeaders: Record<string, string> = {
            'x-s2t-diarization-model': settings.diarizationProfiles?.some(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint) ? settings.diarizationModel : '',
            'content-type': 'audio/wav',
            ...(customEndpoint ? { 'x-s2t-model-id': 'managed-diarization' } : { 'x-s2t-speaker-embeddings': '1' })
          }
          const payload = window.s2t
            ? await window.s2t.diarizeAudio({ endpoint, model: settings.diarizationModel, audio: await audio.arrayBuffer(), embeddings: !customEndpoint })
            : await readJsonResponse<unknown>(await authFetch(endpoint, { method: 'POST', headers: previewHeaders, body: audio }), activeTranslate('stLiveDiarization'))
          // Continuity uses the labels captions already carry from the previous
          // window, so a person keeps one name even when the prior window's
          // turns no longer overlap this one. Only settled captions have a
          // timestamp stable enough to anchor on.
          if (!captureId || liveDraftRef.current?.id !== captureId) return
          const settled = transcriptsRef.current.filter((entry) => entry.status === 'final')
          const turns = stabilizeSpeakerTurns(
            liveSpeakerTurnsRef.current,
            parseSpeakerTurns(payload).map((turn) => ({ ...turn, startMs: turn.startMs + clipStartMs, endMs: turn.endMs + clipStartMs })),
            { captions: settled, embeddings: parseSpeakerEmbeddings(payload), centroids: liveSpeakerCentroidsRef.current }
          )
          if (turns.length) {
            liveSpeakerTurnsRef.current = [...liveSpeakerTurnsRef.current.filter((turn) => turn.endMs >= clipStartMs - 5_000), ...turns]
            setTranscripts((current) => {
              const ready = completedCaptionGroups(current).filter(group => pending.some(sent => sent.id === group.id && captionGroupSignature(sent) === captionGroupSignature(group)))
              const replacements = new Map<string, TranscriptEvent>()
              for (const group of ready) {
                for (const member of assignSpeakersByOverlap(group.members, turns)) replacements.set(member.id, member)
                liveDiarizationGroupsRef.current.set(group.id, captionGroupSignature(group))
              }
              return current.map(entry => replacements.get(entry.id) ?? entry)
            })
          } else {
            for (const group of pending) liveDiarizationGroupsRef.current.set(group.id, captionGroupSignature(group))
          }
        } catch (error) {
          liveDiarizationRetryAtRef.current = Date.now() + 5000
          // Recognition failure is isolated from capture, while still giving the
          // operator a visible, actionable status instead of failing silently.
          if (captureId && liveDraftRef.current?.id === captureId) setStatus(error instanceof Error ? activeTranslate('stLiveDiarizationFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stLiveDiarizationFailed'))
        } finally { liveDiarizationRunningRef.current = false }
      })()
    }, 500)
    return () => window.clearInterval(timer)
  }, [captureState, settings.diarizationEndpoint, settings.diarizationModel, settings.diarizationPreviewEnabled])

useEffect(() => {
    unsubscribeModelRef.current = modelRef.current.onTranscript(receiveTranscript)
    unsubscribeModelErrorRef.current = modelRef.current.onError(setStatus)
    return () => {
      unsubscribeModelRef.current?.()
      unsubscribeModelErrorRef.current?.()
    }
  }, [receiveTranscript])

useEffect(() => {
    if (!isFloatingCaptionWindow) return
    return window.s2t?.onFloatingCaption(setFloatingCaptionText)
  }, [isFloatingCaptionWindow])

useEffect(() => {
    if (isFloatingCaptionWindow) return
    return window.s2t?.onFloatingCaptionClosed(() => setFloatingCaptions(false))
  }, [isFloatingCaptionWindow])

useEffect(() => {
    if (!webCaptionWindow) return
    const doc = webCaptionWindow.document
    const syncFullscreen = (): void => setWebCaptionFullscreen(Boolean(doc.fullscreenElement))
    syncFullscreen()
    doc.addEventListener('fullscreenchange', syncFullscreen)
    return () => doc.removeEventListener('fullscreenchange', syncFullscreen)
  }, [webCaptionWindow])

useEffect(() => () => {
    captionPopoutGenerationRef.current++
    captionPopoutRef.current?.dispose()
    captionPopoutRef.current?.window.close()
    captionPopoutRef.current = null
  }, [])

useEffect(() => {
    if (isFloatingCaptionWindow || !floatingCaptions) return
    const recent = transcripts.filter((entry) => entry.status === 'final' && entry.startMs >= clearedThroughMs && entry.sourceText.trim()).slice(-8)
    window.s2t?.updateFloatingCaption(recent.length ? recent.map((entry) => `${activeTranslate('stCaptionLine').replace('{speaker}', entry.speaker?.trim() || activeTranslate('unassignedSpeaker')).replace('{text}', entry.sourceText)}${entry.translatedText ? `\n${activeTranslate('stCaptionLine').replace('{speaker}', entry.speaker?.trim() || activeTranslate('unassignedSpeaker')).replace('{text}', entry.translatedText)}` : ''}`).join('\n\n') : activeTranslate('waitingForCaptions'))
  }, [floatingCaptions, isFloatingCaptionWindow, transcripts, clearedThroughMs])

useEffect(() => {
    let canceled = false
    let ownedSync: SessionSyncCoordinator | null = null
    void (async () => {
      sessionOwnerActiveRef.current = true
      const owner = requestEpoch()
      const sync = window.s2t ? null : createSessionSyncCoordinator({
        remote: remoteSessionStorage, openOutbox: () => createSessionOutbox(userId), clock: window,
        isActive: () => !canceled && owner === requestEpoch(),
        recover: rows => recoverStaleProcessing(rows, { finishing: finishingSessionRef.current, durableJobs: true, activeRecoveries: recoveryActiveRef.current }),
        onLocal: rows => { sessionsRef.current = rows; storeSessions(rows) },
        onState: state => {
          setRemoteSessionSyncState(state.status); setRemoteSessionConflicts(state.conflicts)
          setSessionStorageStates(current => sessionStorageStatesForSnapshot(state.local, state.baseline, state.acknowledged ? Object.fromEntries(state.local.map(row => [row.id, 'both' as const])) : current))
        },
        onError: error => setStatus(error instanceof Error ? activeTranslate('stRemoteSyncErrorLocalKept').replace('{error}', error.message) : activeTranslate('stRemoteSyncFailedLocalKept'))
      })
      ownedSync = sync; sessionSyncRef.current = sync
      const recoveryStore = window.s2t ? null : createRecordingRecoveryStore(userId)
      const [local, remote, draft, queued, manifests] = await Promise.allSettled([
        window.s2t ? window.s2t.listSessions().then((items) => items as SavedSession[]) : Promise.resolve([] as SavedSession[]),
        window.s2t ? Promise.resolve({ sessions: [] as SavedSession[], version: 0 }) : remoteSessionStorage.load(),
        window.s2t ? Promise.resolve(undefined) : remoteSessionStorage.loadLiveDraft().then(async draft => draft?.opfsRecordingId && await OpfsPcmRecording.isActive(draft.opfsRecordingId) ? undefined : draft),
        sync ? sync.restoreCheckpoint() : Promise.resolve(undefined),
        recoveryStore ? recoveryStore.inspect() : Promise.resolve({ entries: [], issues: [] })
      ])
      if (canceled || owner !== requestEpoch()) return
      const localSessions = local.status === 'fulfilled' ? local.value ?? [] : []
      const remoteSessions = remote.status === 'fulfilled' ? remote.value.sessions : []
      let baseline = remoteSessions, version = remote.status === 'fulfilled' ? remote.value.version : null
      let conflict: SessionConflict | undefined
      setRemoteSessionSyncState(remote.status === 'fulfilled' ? 'ready' : 'paused')
      const recoveryErrors: unknown[] = []
      if (manifests.status === 'rejected') recoveryErrors.push(manifests.reason)
      else recoveryErrors.push(...manifests.value.issues.map(issue => new Error(issue)))
      const recovery = window.s2t ? [] : await recoverRecordings({ manifests: manifests.status === 'fulfilled' ? manifests.value.entries : [], legacyDraft: draft.status === 'fulfilled' ? draft.value : undefined, remoteSessions }, {
        readAudio: async source => (source.manifest ? await recoveryStore!.read(source.manifest).catch(() => undefined) : await OpfsPcmRecording.recover(source.draft.opfsRecordingId!, source.draft.sampleRate!).catch(() => undefined)) || await RemotePcmRecording.recover(source.draft.opfsRecordingId!),
        saveAudio: remoteSessionStorage.saveAudio,
        hasAudio: async key => Boolean(await remoteSessionStorage.loadAudio(key)),
        acknowledge: async source => {
          await remoteSessionStorage.deleteLiveDraft(source.draft.id)
          if (source.manifest) await recoveryStore!.acknowledge(source.manifest.recordingId)
          else if (source.draft.opfsRecordingId) await OpfsPcmRecording.acknowledgeRecovery(source.draft.opfsRecordingId)
        },
        registerCleanup: (id, audioKey, cleanup, token) => sync?.registerCleanup(id, audioKey, cleanup, token),
        title: draft => activeTranslate('stRecoveredCaptionsTitle').replace('{time}', String(new Date(draft.startedAt).toLocaleString('zh-TW'))),
        sourceLabel: draft => activeTranslate('stRecoveredSourceWrap').replace('{source}', draft.source),
        isActive: () => !canceled && sessionOwnerActiveRef.current && owner === requestEpoch(),
        onError: error => recoveryErrors.push(error)
      })
      if (canceled || owner !== requestEpoch()) return
      const hasRecovery = recovery.length > 0
      const recoveryAudioAvailable = recovery.every(entry => !entry.audioUnavailable)
      // Web has one durable source of truth: shared storage. Do not resurrect
      // a Browser Storage copy when it is unavailable. Electron is local-first.
      let primarySessions = window.s2t ? localSessions : remote.status === 'fulfilled' ? remoteSessions : []
      if (!window.s2t && queued.status === 'fulfilled' && queued.value) {
        const checkpoint = queued.value
        primarySessions = checkpoint.local
        baseline = checkpoint.baseline
        if (remote.status === 'fulfilled') {
          try {
            primarySessions = rebaseSessions(checkpoint.baseline, checkpoint.local, remote.value.sessions)
            baseline = remote.value.sessions
          } catch (error) {
            if (error instanceof SessionMergeConflictError) conflict = { baseline: checkpoint.baseline, local: checkpoint.local, remote: remote.value.sessions, version: remote.value.version, ids: error.sessionIds }
            version = null
            setRemoteSessionSyncState('paused')
            setStatus(error instanceof Error ? error.message : activeTranslate('stRemoteSyncFailedLocalKept'))
          }
        }
      }
      if (!window.s2t && queued.status === 'rejected') { version = null; setStatus(queued.reason instanceof Error ? queued.reason.message : 'Session recovery queue is unavailable') }
      const merged = mergeSessions(primarySessions, recovery)
      // Old persisted records encoded generation as a display string. Convert it
      // only while loading; normal summary behavior always relies on summaryState.
      const restoredSessions = recoverStaleProcessing(merged, { finishing: finishingSessionRef.current, durableJobs: !window.s2t }).map(entry => entry.summaryState === 'generating' || (entry.summaryState === undefined && entry.summary === '正在產生摘要…')
        ? { ...entry, summary: entry.summary === '正在產生摘要…' ? undefined : entry.summary, summaryState: 'interrupted' as const, summaryError: entry.summaryError ?? activeTranslate('stSummaryGenerationInterrupted') }
        : entry)
      setSessions(restoredSessions)
      setSessionStorageStates(Object.fromEntries(merged.map(session => [session.id, window.s2t || remote.status !== 'fulfilled' ? 'local' : 'remote'])))
      sync?.initialize({ baseline, local: restoredSessions, version, conflict })
      if (local.status === 'rejected') setStatus(activeTranslate('stLocalLoadFailed'))
      else if (!window.s2t && remote.status === 'rejected') setStatus(activeTranslate('stRemoteLoadFailed'))
      sessionsHydratedRef.current = true
      setSessionsHydrated(true)
      if (hasRecovery) {
        // Keep the recovery draft until both audio and metadata are durable.
        setStatus(recoveryAudioAvailable ? activeTranslate('stRecoveredAudioAndTranscript') : activeTranslate('stRecoveredTranscriptOnly'))
      }
      if (recoveryErrors.length) setStatus(recoveryErrors[0] instanceof Error ? recoveryErrors[0].message : activeTranslate('stLiveDraftSaveFailed'))
      // New Web records are written directly to remote storage. Legacy
      // browser copies are intentionally not read as a second source of truth.
      setAudioMigrationStatus({ copied: 0, pending: 0 })
    })()
    setBrowserRecordingStorage(window.s2t ? 'electron' : typeof navigator.storage?.getDirectory === 'function' ? 'opfs' : 'memory')
    return () => { canceled = true; sessionOwnerActiveRef.current = false; sessionsHydratedRef.current = false; void ownedSync?.close().catch(() => undefined); if (sessionSyncRef.current === ownedSync) sessionSyncRef.current = null }
}, [userId])

const enqueueRemoteSessionSave = (snapshot: SavedSession[]): void => { sessionSyncRef.current?.enqueue(snapshot) }
const retryRemoteSessionSync = async (): Promise<void> => {
  await sessionSyncRef.current?.retry()
  if (sessionOwnerActiveRef.current && sessionSyncRef.current?.getState().status === 'ready') setStatus(activeTranslate('stRemoteReloadScheduled'))
}
const resolveSessionConflict = async (id: string, choice: 'local' | 'remote'): Promise<void> => {
  try { await sessionSyncRef.current?.resolve(id, choice) }
  catch (error) { setStatus(error instanceof Error ? error.message : activeTranslate('stRemoteSyncFailedLocalKept')) }
}

const retryStorageCompensations = async (): Promise<void> => {
  try {
    const response = await authFetch('/api/data/storage-retry', { method: 'POST' })
    const payload = await response.json().catch(() => ({})) as { error?: string; audioPending?: unknown; voiceprintPending?: unknown }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    const audioPending = Number.isSafeInteger(payload.audioPending) ? payload.audioPending as number : 0
    const voiceprintPending = Number.isSafeInteger(payload.voiceprintPending) ? payload.voiceprintPending as number : 0
    setStorageCompensations({ audioPending, voiceprintPending })
    setStatus(audioPending || voiceprintPending ? activeTranslate('stStorageCompensationPending').replace('{audio}', String(audioPending)).replace('{voiceprint}', String(voiceprintPending)) : activeTranslate('stStorageCompensationDone'))
  } catch (error) { setStatus(error instanceof Error ? activeTranslate('stStorageCompensationRetryFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stStorageCompensationRetryFailed')) }
}

const cleanOrphanAudio = async (): Promise<void> => {
  try {
    const response = await authFetch('/api/data/storage-audit', { method: 'POST' })
    const payload = await response.json().catch(() => ({})) as { error?: string; deletedAudio?: unknown }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
    const deleted = Number.isSafeInteger(payload.deletedAudio) ? Number(payload.deletedAudio) : 0
    setStorageOrphanAudio(0)
    setStatus(deleted ? activeTranslate('stOrphanAudioCleaned').replace('{count}', String(deleted)) : activeTranslate('stNoOrphanAudioToClean'))
  } catch (error) { setStatus(error instanceof Error ? activeTranslate('stAudioAuditFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stAudioAuditFailed')) }
}

useEffect(() => {
    if (userRole === 'user') return
    void voiceprintStorage.load().then(setVoiceprints).catch(() => setStatus(activeTranslate('stVoiceprintsLoadFailed')))
  }, [userId, userRole])

useEffect(() => {
    if (window.s2t || !environmentModelsHydrated || !remoteSettingsHydrated) return
    void authFetch('/api/data/model-registry').then(async (response) => {
      if (!response.ok) return
      const payload = await response.json() as { models?: Array<{ id: string; name: string; endpoint: string; model: string; purpose: string; requiresApiKey?: boolean; capabilities?: ModelCapabilities }>; version?: unknown }
      if (!Array.isArray(payload.models)) return
      modelRegistryVersionRef.current = Number.isSafeInteger(payload.version) && Number(payload.version) >= 0 ? Number(payload.version) : 0
      accountServiceModelsRef.current = payload.models.filter(item => ['summary', 'diarization', 'embedding'].includes(item.purpose))
      modelRegistrySignatureRef.current = JSON.stringify(payload.models)
      // The initial health request can finish before this asynchronous catalog
      // load, leaving every user-managed model card at "未確認" until the
      // five-minute poll. Refresh as soon as the catalog becomes available.
      void refreshModelHealth()
      setSettings((current) => {
        const asr = payload.models!.flatMap((item) => item.purpose === 'asr' ? [{ id: item.id, name: item.name, endpoint: item.endpoint, model: item.model, kind: 'openai-http' as const, requiresApiKey: item.requiresApiKey !== false, capabilities: { ...defaultHttpCapabilities, ...item.capabilities } }] : [])
        const translation = payload.models!.flatMap((item) => item.purpose === 'translation' ? [{ id: item.id, name: item.name, endpoint: item.endpoint, model: item.model, requiresApiKey: item.requiresApiKey !== false }] : [])
        const summaryModel = payload.models!.find((item) => item.purpose === 'summary')
        const diarizationModel = payload.models!.find((item) => item.purpose === 'diarization')
        const embeddingModel = payload.models!.find((item) => item.purpose === 'embedding')
        return applyEnvironmentSettings({ ...current, modelProfiles: [...current.modelProfiles.filter((item) => item.id === 'none' || item.id.startsWith('web-')), ...asr], translationProfiles: [...current.translationProfiles.filter((item) => item.id.startsWith('web-')), ...translation], ...(summaryModel ? { summaryEndpoint: summaryModel.endpoint, summaryModel: summaryModel.model, summaryRequiresApiKey: summaryModel.requiresApiKey !== false } : {}), ...(diarizationModel ? { diarizationEndpoint: diarizationModel.endpoint, diarizationModel: diarizationModel.model, diarizationRequiresApiKey: diarizationModel.requiresApiKey !== false } : {}), ...(embeddingModel ? { embeddingEndpoint: embeddingModel.endpoint, embeddingModel: embeddingModel.model, embeddingRequiresApiKey: embeddingModel.requiresApiKey !== false } : {}) }, environmentConfigRef.current, false)
      })
    }).catch(() => undefined)
  }, [userId, environmentModelsHydrated, remoteSettingsHydrated])

useEffect(() => {
    void refreshModelHealth()
    const timer = window.setInterval(() => { void refreshModelHealth() }, 300_000)
    return () => window.clearInterval(timer)
  }, [refreshModelHealth])

useEffect(() => {
    // Ask the gateway whether the Silero VAD model actually loads (model file +
    // sha256 + onnxruntime-node) before offering the checkbox that enables it.
    let canceled = false
    const check = async (): Promise<void> => {
      try {
        const response = await authFetch('/api/audio-processing/status')
        const payload = await response.json() as { sileroVad?: { available?: boolean } }
        if (!canceled) setSileroVadAvailable(Boolean(response.ok && payload.sileroVad?.available))
      } catch { if (!canceled) setSileroVadAvailable(false) }
    }
    void check()
    const timer = window.setInterval(() => { void check() }, 300_000)
    return () => { canceled = true; window.clearInterval(timer) }
  }, [])

useEffect(() => {
    // Never leave recording blocked: if the model cannot load, drop the toggle.
    if (sileroVadAvailable === false && settings.sileroVadEnabled) setSettings((current) => ({ ...current, sileroVadEnabled: false }))
  }, [sileroVadAvailable, settings.sileroVadEnabled, setSettings])

useEffect(() => {
    if (userRole !== 'admin' || window.s2t || modelRegistryVersionRef.current === null) return
    const models = [
      ...settings.modelProfiles.filter((item) => item.id !== 'none' && !item.id.startsWith('web-')).map((item) => ({ id: item.id, name: item.name, endpoint: item.endpoint, model: item.model, purpose: 'asr', requiresApiKey: item.requiresApiKey !== false, capabilities: item.capabilities })),
      ...settings.translationProfiles.filter((item) => !item.id.startsWith('web-')).map((item) => ({ id: item.id, name: item.name, endpoint: item.endpoint, model: item.model, purpose: 'translation', requiresApiKey: item.requiresApiKey !== false, capabilities: {} })),
      ...(environmentConfigRef.current.summary?.configured ? accountServiceModelsRef.current.filter(item => item.purpose === 'summary') : settings.summaryEndpoint.trim() && settings.summaryModel.trim() ? [{ id: 'managed-summary', name: activeTranslate('summaryTitle'), endpoint: settings.summaryEndpoint, model: settings.summaryModel, purpose: 'summary', requiresApiKey: settings.summaryRequiresApiKey, capabilities: {} }] : []),
      ...(environmentConfigRef.current.diarization?.configured ? accountServiceModelsRef.current.filter(item => item.purpose === 'diarization') : settings.diarizationEndpoint.trim() && settings.diarizationModel.trim() ? [{ id: 'managed-diarization', name: activeTranslate('speakerDiarization'), endpoint: settings.diarizationEndpoint, model: settings.diarizationModel, purpose: 'diarization', requiresApiKey: settings.diarizationRequiresApiKey, capabilities: {} }] : []),
      ...(settings.embeddingEndpoint.trim() && settings.embeddingModel.trim() ? [{ id: 'managed-embedding', name: activeTranslate('embedding'), endpoint: settings.embeddingEndpoint, model: settings.embeddingModel, purpose: 'embedding', requiresApiKey: settings.embeddingRequiresApiKey, capabilities: {} }] : [])
    ]
    const signature = JSON.stringify(models)
    if (signature === modelRegistrySignatureRef.current) return
    const timer = window.setTimeout(() => {
      const version = modelRegistryVersionRef.current
      if (version === null) return
      void retryableAuthFetch('/api/data/model-registry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models, version }) }).then(async (response) => {
        if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) }
        const saved = await response.json() as { version?: unknown }
        if (!Number.isSafeInteger(saved.version) || Number(saved.version) < 1) throw new Error(activeTranslate('stServerNoValidModelVersion'))
        modelRegistryVersionRef.current = Number(saved.version)
        modelRegistrySignatureRef.current = signature
        void refreshModelHealth()
      }).catch((error: unknown) => setStatus(error instanceof Error ? activeTranslate('stModelListSaveFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stModelListSaveFailed')))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [settings.modelProfiles, settings.translationProfiles, settings.summaryEndpoint, settings.summaryModel, settings.summaryRequiresApiKey, settings.diarizationEndpoint, settings.diarizationModel, settings.diarizationRequiresApiKey, settings.embeddingEndpoint, settings.embeddingModel, settings.embeddingRequiresApiKey, refreshModelHealth, userRole])

useEffect(() => {
    let canceled = false
    if (window.s2t) { setRemoteSettingsHydrated(true); return }
    setRemoteSettingsHydrated(false)
    remoteSettingsVersionRef.current = null
    void authFetch('/api/data/settings').then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json() as { settings?: unknown; version?: unknown }
      remoteSettingsVersionRef.current = Number.isSafeInteger(payload.version) && Number(payload.version) >= 0 ? Number(payload.version) : 0
      if (canceled || !payload.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) return
      setSettings((current) => normalizeSettings({ ...current, ...(payload.settings as Partial<Settings>) }))
    }).catch(() => { if (!canceled) remoteSettingsVersionRef.current = null }).finally(() => { if (!canceled) setRemoteSettingsHydrated(true) })
    return () => { canceled = true }
  }, [userId])

useEffect(() => {
    void authFetch('/api/data/glossary').then(async (response) => {
      if (!response.ok) return
      const payload = await response.json() as { glossary?: string; version?: number }
      if (typeof payload.glossary === 'string') { const glossary = payload.glossary; glossaryVersionRef.current = Number.isSafeInteger(payload.version) && payload.version! >= 0 ? payload.version! : 0; setSettings((current) => ({ ...current, glossary })) }
    }).catch(() => undefined)
  }, [userId])

useEffect(() => {
    void authFetch('/api/storage').then(async (response) => {
      if (!response.ok) { setStorageHealth(null); return }
      const value = await response.json() as { mode?: { blob?: unknown; config?: unknown; vector?: unknown }; schemaVersion?: unknown; ready?: unknown }
      if (typeof value.mode?.blob === 'string' && typeof value.mode.config === 'string' && typeof value.mode.vector === 'string' && typeof value.schemaVersion === 'string' && typeof value.ready === 'boolean') setStorageHealth({ mode: { blob: value.mode.blob, config: value.mode.config, vector: value.mode.vector }, schemaVersion: value.schemaVersion, ready: value.ready })
      else setStorageHealth(null)
    }).catch(() => setStorageHealth(null))
  }, [userId])

useEffect(() => {
    void authFetch('/api/data/storage-status').then(async (response) => {
      if (!response.ok) { setStorageCompensations(null); return }
      const value = await response.json() as { audioPending?: unknown; voiceprintPending?: unknown }
      setStorageCompensations(Number.isSafeInteger(value.audioPending) && Number.isSafeInteger(value.voiceprintPending) ? { audioPending: value.audioPending as number, voiceprintPending: value.voiceprintPending as number } : null)
    }).catch(() => setStorageCompensations(null))
  }, [userId])

useEffect(() => {
    void authFetch('/api/data/storage-audit').then(async (response) => {
      if (!response.ok) { setStorageOrphanAudio(null); return }
      const value = await response.json() as { orphanAudio?: unknown }
      setStorageOrphanAudio(Number.isSafeInteger(value.orphanAudio) ? Number(value.orphanAudio) : null)
    }).catch(() => setStorageOrphanAudio(null))
  }, [userId])

useEffect(() => {
    let canceled = false
    if (window.s2t) { setSummaryTemplatesHydrated(true); return }
    void authFetch('/api/data/summary-templates').then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || `HTTP ${response.status}`)
      const payload = await response.json() as { templates?: Settings['summaryTemplates']; selectedTemplateId?: string; version?: number }
      summaryTemplateVersionRef.current = Number.isSafeInteger(payload.version) && payload.version! >= 0 ? payload.version! : 0
      if (canceled || !Array.isArray(payload.templates) || !payload.templates.length) return
      setSettings((current) => normalizeSettings({ ...current, summaryTemplates: payload.templates, selectedSummaryTemplateId: payload.selectedTemplateId }))
    }).catch((error: unknown) => { if (!canceled) setStatus(error instanceof Error ? error.message : activeTranslate('stSummaryTemplateSaveFailed')) }).finally(() => { if (!canceled) setSummaryTemplatesHydrated(true) })
    return () => { canceled = true }
  }, [userId])

useEffect(() => {
    if (!sessionsHydrated || window.s2t) return
    enqueueRemoteSessionSave(sessions)
  }, [sessions, sessionsHydrated])

useEffect(() => {
    if (window.s2t || !remoteSettingsHydrated || !environmentModelsHydrated || remoteSettingsVersionRef.current === null) return
    const timer = window.setTimeout(() => {
      const version = remoteSettingsVersionRef.current
      if (version === null) return
      void retryableAuthFetch('/api/data/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: remoteSettingsPayload(settings), version }) }).then(async (response) => {
        if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) }
        const saved = await response.json() as { version?: unknown }
        if (!Number.isSafeInteger(saved.version) || Number(saved.version) < 1) throw new Error(activeTranslate('stServerNoValidSettingsVersion'))
        remoteSettingsVersionRef.current = Number(saved.version)
      }).catch((error: unknown) => setStatus(error instanceof Error ? activeTranslate('stRemoteSettingsSaveFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stRemoteSettingsSaveFailed')))
    }, 400)
    return () => window.clearTimeout(timer)
  }, [remoteSettingsHydrated, environmentModelsHydrated, settings])

useEffect(() => {
    if (window.s2t || !summaryTemplatesHydrated || summaryTemplateVersionRef.current === null) return
    const timer = window.setTimeout(() => {
      summaryTemplateSaveRef.current = summaryTemplateSaveRef.current.then(async () => {
        const version = summaryTemplateVersionRef.current
        if (version === null) return
        await retryableAuthFetch('/api/data/summary-templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templates: settings.summaryTemplates.filter(template => !template.sourceFile), selectedTemplateId: settings.selectedSummaryTemplateId, version }) }).then(async (response) => {
          if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) }
          const saved = await response.json() as { version?: number }
          if (!Number.isSafeInteger(saved.version) || saved.version! < 1) throw new Error(activeTranslate('stServerNoValidTemplateVersion'))
          summaryTemplateVersionRef.current = saved.version!
        }).catch((error: unknown) => setStatus(error instanceof Error ? activeTranslate('stSummaryTemplateSaveFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stSummaryTemplateSaveFailed')))
      })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [settings.selectedSummaryTemplateId, settings.summaryTemplates, summaryTemplatesHydrated])

// Electron persists personal settings plus admin-owned shared models. Web persists them
// via the gateway effect above; neither path uses Browser Storage.
useEffect(() => {
    if (!window.s2t || !environmentModelsHydrated) return
    const timer = window.setTimeout(() => {
      void window.s2t?.saveModelConfig(settings).catch(() => setStatus(activeTranslate('stModelConfigSaveFailed')))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [settings, environmentModelsHydrated])

useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => { document.documentElement.dataset.theme = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme }
    apply(); media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings.theme])

useEffect(() => {
    if (!window.s2t) return
    void window.s2t.listRecoverableRecordings().then((recordings) => {
      if (!recordings.length) return
      setSessions((current) => {
        const known = new Set(current.map((entry) => entry.id))
        const recovered = recordings.flatMap((entry): SavedSession[] => {
          const id = `recovery-${entry.id}`
          return known.has(id) ? [] : [{
            id, title: activeTranslate('stRecoveredRecordingTitle').replace('{time}', String(new Date(entry.createdAt).toLocaleString('zh-TW'))),
            createdAt: entry.createdAt, durationMs: 0, source: activeTranslate('stForcedQuitRecovery'), transcript: '', audioKey: '',
            nativeAudioPath: entry.audioPath, savedToDisk: false, segments: []
          }]
        })
        return recovered.length ? [...recovered, ...current] : current
      })
      setStatus(activeTranslate('stUnsavedRecordingFound'))
    }).catch(() => undefined)
  }, [])

useEffect(() => {
    if (!window.s2t && !remoteSettingsHydrated) return
    let canceled = false
    void (async () => {
      const [saved, config]: [Partial<Settings> | null, EnvironmentModels] = window.s2t
        ? await Promise.all([
          window.s2t.loadModelConfig().catch(() => null),
          window.s2t.getEnvironmentModels()
        ])
        : [null, await readJsonResponse<EnvironmentModels>(await authFetch('/api/config'), activeTranslate('stModelSettings'))]
      if (canceled) return
      setPromptCatalog(config.prompts)
      environmentConfigRef.current = config
      setProductTitleImage(config.branding?.titleImage || '')
      setSettings((previous) => {
        return applyEnvironmentSettings({ ...previous, ...saved }, config, Boolean(window.s2t))
      })
    })().catch((error: unknown) => setStatus(error instanceof Error ? error.message : activeTranslate('stModelSettingsLoadFailed'))).finally(() => { if (!canceled) setEnvironmentModelsHydrated(true) })
    return () => { canceled = true }
  }, [remoteSettingsHydrated, userId])

const cleanUpCapture = useCallback(() => {
    liveCorrectionEpochRef.current += 1
    liveCorrectionAudioRef.current = null
    if (meterFrameRef.current) cancelAnimationFrame(meterFrameRef.current)
    if (timerRef.current) window.clearInterval(timerRef.current)
    meterFrameRef.current = null
    timerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    systemStreamRef.current?.getTracks().forEach((track) => track.stop())
    systemStreamRef.current = null
    sourceRef.current?.disconnect()
    sourceRef.current = null
    systemSourceRef.current?.disconnect()
    systemSourceRef.current = null
    void contextRef.current?.close()
    contextRef.current = null
    microphoneAnalyserRef.current = null
    systemAnalyserRef.current = null
    meterSinkGainRef.current?.disconnect()
    meterSinkGainRef.current = null
    audioWorkletRef.current?.disconnect()
    audioWorkletRef.current = null
    silentGainRef.current?.disconnect()
    silentGainRef.current = null
    recordingDestinationRef.current?.disconnect()
    recordingDestinationRef.current = null
  }, [])

useEffect(() => () => {
    const sink = pcmSinkRef.current, writer = pcmWriterRef.current
    if (sink) void (writer?.closeAndDrain() ?? Promise.resolve()).catch(() => undefined).then(() => sink.abort()).catch(() => undefined)
    cleanUpCapture()
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
  }, [cleanUpCapture])

const updateMeter = useCallback(() => {
    const read = (analyser: AnalyserNode | null): number => {
      if (!analyser) return -60
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples)
      let sum = 0; for (const sample of samples) sum += sample * sample
      return dbfs(Math.sqrt(sum / samples.length))
    }
    const microphone = read(microphoneAnalyserRef.current)
    const system = read(systemAnalyserRef.current)
    // Update the coloured bar directly on every animation frame. React state
    // remains for the readable dBFS label, but must not delay the meter while
    // transcription requests or transcript rendering keep the UI busy.
    microphoneMeterValueRef.current?.style.setProperty('width', `${meterPercent(microphone)}%`)
    systemMeterValueRef.current?.style.setProperty('width', `${meterPercent(system)}%`)
    if (performance.now() - meterLastUiUpdateRef.current > 100) {
      meterLastUiUpdateRef.current = performance.now()
      setMicrophoneLevel(microphone); setSystemLevel(system)
    }
    meterFrameRef.current = requestAnimationFrame(updateMeter)
  }, [])

const attachInput = useCallback((stream: MediaStream, context: AudioContext): void => {
    const source = context.createMediaStreamSource(stream)
    const analyser = microphoneAnalyserRef.current
    const processor = audioWorkletRef.current
    const recordingDestination = recordingDestinationRef.current
    if (!analyser || !processor || !recordingDestination) throw new Error(activeTranslate('stAudioPipelineNotReady'))
    source.connect(analyser)
    source.connect(processor)
    source.connect(recordingDestination)
    sourceRef.current = source
    streamRef.current = stream
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (streamRef.current === stream) {
          setStatus(activeTranslate('stCurrentSourceInterrupted'))
          void refreshDevices()
        }
      }, { once: true })
    })
  }, [refreshDevices])

const attachSystemAudio = useCallback((stream: MediaStream, context: AudioContext): void => {
    if (stream.getAudioTracks().length === 0) { stream.getTracks().forEach((track) => track.stop()); throw new Error(activeTranslate('stShareSourceNoSystemAudio')) }
    const analyser = systemAnalyserRef.current
    const processor = audioWorkletRef.current
    const recordingDestination = recordingDestinationRef.current
    if (!analyser || !processor || !recordingDestination) throw new Error(activeTranslate('stAudioPipelineNotReady'))
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)
    source.connect(processor)
    source.connect(recordingDestination)
    systemSourceRef.current = source
    systemStreamRef.current = stream
    stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
      if (systemStreamRef.current !== stream) return
      systemSourceRef.current?.disconnect()
      stream.getTracks().forEach((item) => item.stop())
      systemStreamRef.current = null
      setIncludeSystemAudio(false)
      setStatus(streamRef.current ? activeTranslate('stSystemAudioShareEndedMicContinues') : activeTranslate('stSystemAudioShareEndedStopToRestart'))
    }, { once: true }))
  }, [])

const switchInput = useCallback(async (nextDeviceId: string): Promise<void> => {
    const context = contextRef.current
    if (!context) return
    const previousStream = streamRef.current
    const previousSource = sourceRef.current
    setStatus(activeTranslate('stSwitchingSource'))
    try {
      if (nextDeviceId === 'none') {
        if (!systemStreamRef.current?.getAudioTracks().some((track) => track.readyState === 'live')) throw new Error(activeTranslate('stAtLeastOneSourceRequired'))
        previousSource?.disconnect(); previousStream?.getTracks().forEach((track) => track.stop())
        streamRef.current = null; sourceRef.current = null
        setDenoiseApplied(null)
        activeDeviceIdRef.current = 'none'; setSelectedDeviceId('none'); setStatus(activeTranslate('stUsingSystemAudio')); return
      }
      const deviceId = nextDeviceId === 'default' ? undefined : { exact: nextDeviceId }
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId, echoCancellation: true, noiseSuppression: settings.denoiseEnabled, autoGainControl: true },
        video: false
      })
      const applied = nextStream.getAudioTracks()[0]?.getSettings().noiseSuppression
      setDenoiseApplied(typeof applied === 'boolean' ? applied : null)
      attachInput(nextStream, context)
      previousSource?.disconnect()
      previousStream?.getTracks().forEach((track) => track.stop())
      activeDeviceIdRef.current = nextDeviceId
      setSelectedDeviceId(nextDeviceId)
      setStatus(captureState === 'paused' ? activeTranslate('stPausedSourceSwitched') : activeTranslate('stRecordingSourceSwitched'))
    } catch (error) {
      setSelectedDeviceId(activeDeviceIdRef.current)
      setStatus(error instanceof Error ? activeTranslate('stSwitchSourceFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stSwitchSourceFailed'))
      throw error
    }
  }, [attachInput, captureState, settings.denoiseEnabled])

const selectDevice = async (nextDeviceId: string): Promise<void> => {
    if (captureState === 'recording' || captureState === 'paused') {
      await switchInput(nextDeviceId)
      return
    }
    setSelectedDeviceId(nextDeviceId)
  }

const selectSystemAudio = async (enabled: boolean): Promise<void> => {
    const active = captureState === 'recording' || captureState === 'paused'
    if (!enabled) {
      if (active && selectedDeviceId === 'none') {
        setStatus(activeTranslate('stSystemAudioOnlyChooseMicFirst'))
        return
      }
      systemSourceRef.current?.disconnect()
      systemSourceRef.current = null
      systemStreamRef.current?.getTracks().forEach((track) => track.stop())
      systemStreamRef.current = null
      setSystemLevel(-60)
      setIncludeSystemAudio(false)
      if (active) setStatus(activeTranslate('stSystemAudioRemoved'))
      return
    }
    if (!active) { setIncludeSystemAudio(true); return }
    const context = contextRef.current
    if (!context) return
    setStatus(activeTranslate('stChooseSystemAudioSource'))
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      systemSourceRef.current?.disconnect()
      systemStreamRef.current?.getTracks().forEach((track) => track.stop())
      systemSourceRef.current = null
      systemStreamRef.current = null
      attachSystemAudio(stream, context)
      setIncludeSystemAudio(true)
      setStatus(captureState === 'paused' ? activeTranslate('stPausedSystemAudioAttached') : activeTranslate('stSystemAudioAttached'))
    } catch (error) {
      setIncludeSystemAudio(false)
      setStatus(error instanceof Error ? activeTranslate('stSwitchSystemAudioFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stSwitchSystemAudioFailed'))
    }
  }

const applyAudioSources = async (deviceId: string, systemEnabled: boolean, preparedSystem?: MediaStream): Promise<void> => {
    const active = captureState === 'recording' || captureState === 'paused'
    if (deviceId === 'none' && !systemEnabled) throw new Error(activeTranslate('stAtLeastOneSourceRequired'))
    const nextSystem = systemEnabled ? preparedSystem ?? systemStreamRef.current : null
    if (systemEnabled && !nextSystem?.getAudioTracks().some(track => track.readyState === 'live')) throw new Error(activeTranslate('stShareSourceNoAudio'))
    if (active && !contextRef.current) throw new Error(activeTranslate('stAudioPipelineNotReady'))
    if (deviceId !== 'none') await selectDevice(deviceId)
    const oldStream = systemStreamRef.current, oldSource = systemSourceRef.current
    if (nextSystem !== oldStream) {
      // Attach the chosen stream before retiring the current source.
      if (active && nextSystem) attachSystemAudio(nextSystem, contextRef.current!)
      else { systemStreamRef.current = nextSystem; systemSourceRef.current = null }
      oldSource?.disconnect()
      oldStream?.getTracks().forEach(track => track.stop())
    }
    setIncludeSystemAudio(systemEnabled)
    if (!systemEnabled) setSystemLevel(-60)
    if (deviceId === 'none') await selectDevice(deviceId)
  }

const startCapture = async (audioChoice?: CaptureAudioChoice): Promise<void> => {
    const captureDeviceId = audioChoice?.deviceId ?? selectedDeviceId
    const captureSystemAudio = audioChoice?.systemEnabled ?? includeSystemAudio
    if (captureState !== 'idle' || (captureDeviceId === 'none' && !captureSystemAudio)) return
    const continuationSnapshot = continuationTargetRef.current?.entry.modelSnapshot
    const captureModel: ModelProfile = continuationSnapshot ? {
      id: continuationSnapshot.id, name: continuationSnapshot.name, endpoint: continuationSnapshot.endpoint,
      model: continuationSnapshot.model, kind: continuationSnapshot.kind, requiresApiKey: continuationSnapshot.requiresApiKey,
      capabilities: continuationSnapshot.capabilities
    } : selectedModel
    const captureSourceLanguage = continuationSnapshot?.sourceLanguage ?? settings.sourceLanguage
    const capturePrompt = continuationSnapshot?.prompt ?? settings.glossary
    const captureGatewayProfileId = gatewayAsrProfileId(captureModel.id)
    // Preprocessing is optional. A rolling deploy can briefly route this
    // request to a Pod whose model volume/FFmpeg is not ready; do not turn a
    // transient 503 into a failure to start recording or to use the ASR API.
    let captureSileroVadEnabled = settings.sileroVadEnabled
    let captureDynaudnormEnabled = settings.dynaudnormEnabled
    let preprocessingFallback = ''
    if (!window.s2t && !captureGatewayProfileId) {
      setStatus(interfaceTranslate(settings.uiLanguage, 'webGatewayModelRequired'))
      return
    }
    if (captureSileroVadEnabled || captureDynaudnormEnabled) {
      if (window.s2t) { setStatus(activeTranslate('stSileroProvidedByGateway')); return }
      try {
        const response = await authFetch('/api/audio-processing/status')
        const payload = await response.json() as { sileroVad?: { available?: boolean; reason?: string }; dynaudnorm?: { available?: boolean; reason?: string } }
        const unavailable: string[] = []
        if (!response.ok || !payload.sileroVad?.available) {
          if (captureSileroVadEnabled) unavailable.push(activeTranslate('stSileroVadReason').replace('{reason}', payload.sileroVad?.reason || activeTranslate('stModelNotReady')))
          captureSileroVadEnabled = false
        }
        if (!response.ok || !payload.dynaudnorm?.available) {
          if (captureDynaudnormEnabled) unavailable.push(activeTranslate('stDynaudnormReason').replace('{reason}', payload.dynaudnorm?.reason || activeTranslate('stFfmpegNotReady')))
          captureDynaudnormEnabled = false
        }
        if (unavailable.length) preprocessingFallback = activeTranslate('stPreprocessingSkipped').replace('{list}', unavailable.join(activeTranslate('stListSeparatorWide')))
      } catch {
        const unavailable: string[] = []
        if (captureSileroVadEnabled) unavailable.push('Silero VAD')
        if (captureDynaudnormEnabled) unavailable.push('dynaudnorm')
        captureSileroVadEnabled = false
        captureDynaudnormEnabled = false
        preprocessingFallback = activeTranslate('stHealthCheckUnavailableSkipped').replace('{list}', unavailable.join(activeTranslate('stListSeparatorEnum')))
      }
    }
    const supportedLanguages = captureModel.capabilities.supportedLanguages ?? []
    if (captureSourceLanguage !== 'auto' && supportedLanguages.length && !supportedLanguages.includes(captureSourceLanguage)) { setStatus(activeTranslate('stModelLanguageUnsupported').replace('{name}', String(captureModel.name)).replace('{language}', String(languageName(captureSourceLanguage)))); return }
    translationQueueRef.current!.reset()
    translationQueueRef.current!.paused = false
    setCaptureState('starting')
    try {
      setStatus(captureSystemAudio ? activeTranslate('stChooseSystemAudioSource') : activeTranslate('stRequestingMicPermission'))
      // Request the system picker directly from the user's click.
      if (captureSystemAudio) {
        const systemStream = systemStreamRef.current?.getAudioTracks().some(track => track.readyState === 'live') ? systemStreamRef.current : await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        systemStreamRef.current = systemStream
        if (!systemStream.getAudioTracks().length) throw new Error(activeTranslate('stShareSourceNoAudio'))
      }
      const deviceId = captureDeviceId === 'default' ? undefined : { exact: captureDeviceId }
      const stream = captureDeviceId === 'none' ? null : await navigator.mediaDevices.getUserMedia({
        audio: { deviceId, echoCancellation: true, noiseSuppression: settings.denoiseEnabled, autoGainControl: true },
        video: false
      })
      streamRef.current = stream
      const applied = stream?.getAudioTracks()[0]?.getSettings().noiseSuppression
      setDenoiseApplied(typeof applied === 'boolean' ? applied : null)
      await refreshDevices()

      unsubscribeModelRef.current?.()
      unsubscribeModelErrorRef.current?.()
      modelRef.current = captureModel.kind === 'openai-http'
        ? createOpenAiChunkedModelAdapter({ ...captureModel, gatewayProfileId: captureGatewayProfileId ?? undefined, prompt: capturePrompt.trim() || undefined, vadConfig: effectiveVadConfig, strictChunkLimits: Boolean(adminParameters), sileroVadEnabled: captureSileroVadEnabled, dynaudnormEnabled: captureDynaudnormEnabled })
        : captureModel.endpoint.trim()
          ? new WebSocketModelAdapter(captureModel.endpoint.trim())
          : new NoopModelAdapter()
      unsubscribeModelRef.current = modelRef.current.onTranscript(receiveTranscript)
      unsubscribeModelErrorRef.current = modelRef.current.onError(setStatus)

      const context = new AudioContext()
      const supportedSampleRates = captureModel.capabilities.supportedSampleRates ?? []
      const modelSampleRate = chooseModelSampleRate(context.sampleRate, supportedSampleRates)
      activeModelSnapshotRef.current = {
        id: captureModel.id,
        name: captureModel.name,
        endpoint: captureModel.endpoint,
        model: captureModel.model,
        kind: captureModel.kind,
        requiresApiKey: captureModel.requiresApiKey !== false,
        capabilities: { ...captureModel.capabilities, supportedLanguages: [...(captureModel.capabilities.supportedLanguages ?? [])], supportedSampleRates: [...supportedSampleRates] },
        sourceLanguage: captureSourceLanguage,
        prompt: capturePrompt,
        inputSampleRate: context.sampleRate,
        modelSampleRate
      }
      const resampler = new StreamingResampler(context.sampleRate, modelSampleRate, { kaiserWindow: settings.kaiserResampleEnabled })
      resamplerRef.current = resampler
      const microphoneAnalyser = context.createAnalyser(); microphoneAnalyser.fftSize = 1024
      const systemAnalyser = context.createAnalyser(); systemAnalyser.fftSize = 1024
      await context.audioWorklet.addModule(new URL('../../capture/audio-capture.worklet.js', import.meta.url))
      const processor = new AudioWorkletNode(context, 's2t-audio-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit'
      })
      const silentGain = context.createGain()
      const meterSinkGain = context.createGain()
      const recordingDestination = context.createMediaStreamDestination()
      silentGain.gain.value = 0
      meterSinkGain.gain.value = 0
      await context.resume()
      // The meter has its own direct, silent branch. WAV writing, VAD and ASR
      // operate in the processor branch and cannot pause the user-facing bar.
      microphoneAnalyser.connect(meterSinkGain); systemAnalyser.connect(meterSinkGain)
      meterSinkGain.connect(context.destination)
      liveCorrectionEpochRef.current += 1
      liveCorrectionDoneRef.current.clear()
      liveCorrectionFailuresRef.current.clear()
      liveCorrectionAudioRef.current = new CorrectionAudioBuffer(modelSampleRate)
      sampleOffsetRef.current = 0
      liveDiarizationStartSampleRef.current = 0
      liveDiarizationChunksRef.current = []
      liveDiarizationHeadRef.current = 0
      liveDiarizationSamplesRef.current = 0
      liveDiarizationGroupsRef.current.clear()
      liveDiarizationRetryAtRef.current = 0
      liveSpeakerTurnsRef.current = []
      liveSpeakerCentroidsRef.current = new Map()
      processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const samples = new Float32Array(event.data)
        if (pausedRef.current) return
        if (pcmSinkRef.current) pcmWriterRef.current?.push(pcm16(samples))
        else {
          pcmChunksRef.current.push(samples)
          memoryRecordingBytesRef.current += samples.byteLength
          if (memoryRecordingBytesRef.current >= maximumMemoryRecordingBytes && !memoryRecordingLimitReachedRef.current) {
            memoryRecordingLimitReachedRef.current = true
            pausedRef.current = true
            pauseStartedAtRef.current = Date.now()
            if (recorderRef.current?.state === 'recording') recorderRef.current.pause()
            setCaptureState('paused')
            setStatus(activeTranslate('stMemoryRecordingLimitOpfs').replace('{size}', String(Math.round(maximumMemoryRecordingBytes / 1024 / 1024))))
          }
        }
        if (settings.diarizationModel && settings.diarizationPreviewEnabled) {
          liveDiarizationChunksRef.current.push(samples)
          const maximumPreviewSamples = Math.floor(sampleRateRef.current * 45)
          liveDiarizationSamplesRef.current += samples.length
          while (liveDiarizationSamplesRef.current > maximumPreviewSamples && liveDiarizationChunksRef.current.length - liveDiarizationHeadRef.current > 1) {
            const removed = liveDiarizationChunksRef.current[liveDiarizationHeadRef.current++]
            liveDiarizationSamplesRef.current -= removed.length
            liveDiarizationStartSampleRef.current += removed.length
          }
          if (liveDiarizationHeadRef.current >= 4096 && liveDiarizationHeadRef.current >= liveDiarizationChunksRef.current.length / 2) {
            liveDiarizationChunksRef.current = liveDiarizationChunksRef.current.slice(liveDiarizationHeadRef.current)
            liveDiarizationHeadRef.current = 0
          }
        }
        const modelSamples = resampler.process(samples)
        if (!modelSamples.length) return
        liveCorrectionAudioRef.current?.push(modelSamples)
        modelRef.current.pushAudio(modelSamples, sampleOffsetRef.current)
        sampleOffsetRef.current += modelSamples.length
      }
      processor.connect(silentGain)
      silentGain.connect(context.destination)
      contextRef.current = context
      microphoneAnalyserRef.current = microphoneAnalyser
      systemAnalyserRef.current = systemAnalyser
      meterSinkGainRef.current = meterSinkGain
      audioWorkletRef.current = processor
      silentGainRef.current = silentGain
      recordingDestinationRef.current = recordingDestination
      pcmChunksRef.current = []
      memoryRecordingBytesRef.current = 0
      memoryRecordingLimitReachedRef.current = false
      sampleRateRef.current = context.sampleRate
      modelSampleRateRef.current = modelSampleRate
      await modelRef.current.start({ sampleRate: modelSampleRate, language: captureSourceLanguage, targetLanguage: settings.targetLanguage })
      if (modelSampleRate !== context.sampleRate) setStatus(activeTranslate('stSampleRateConverted').replace('{sampleRate}', String(context.sampleRate)).replace('{modelSampleRate}', String(modelSampleRate)))
      liveDraftRef.current = { id: crypto.randomUUID(), startedAt: new Date().toISOString() }
      electronRecordingIdRef.current = window.s2t ? (await window.s2t.startPcmRecording(context.sampleRate)).id : null
      pcmWriterPausedRef.current = false
      pcmWriterFailedRef.current = false
      if (!window.s2t) {
        const opfsId = `capture-${crypto.randomUUID()}`
        opfsRecordingRef.current = await OpfsPcmRecording.create(opfsId, context.sampleRate, { ownerId: userId, captureOffsetMs: continuationTargetRef.current?.baseDurationMs ?? 0, draft: { ...liveDraftRef.current!, updatedAt: new Date().toISOString(), captureState: 'recording', source: captureSystemAudio ? activeTranslate('stSourceMicAndSystem') : activeTranslate('microphone'), elapsedMs: 0, segments: [], opfsRecordingId: opfsId, sampleRate: context.sampleRate } }).catch(() => null)
        opfsRecordingIdRef.current = opfsRecordingRef.current ? opfsId : null
        const configResponse = await authFetch('/api/config')
        if (!configResponse.ok) throw new Error(activeTranslate('recordingConfigUnavailable'))
        const config = await configResponse.json() as { capabilities?: { distributed?: boolean; durableRecordingChunks?: boolean } }
        if (config.capabilities?.distributed && config.capabilities.durableRecordingChunks) {
          if (!opfsRecordingRef.current) throw new Error(activeTranslate('distributedRecordingNeedsStorage'))
          remotePcmRecordingRef.current = new RemotePcmRecording(opfsId, context.sampleRate)
        }

      }
      if (electronRecordingIdRef.current && window.s2t) {
        const sink = createDesktopPcmSink(electronRecordingIdRef.current, window.s2t)
        pcmSinkRef.current = sink
        pcmWriterRef.current = new BufferedPcmWriter(
          audio => sink.append(audio),
          (active) => {
            const recorder = recorderRef.current
            if (active) {
              if (pcmWriterPausedRef.current) return
              pcmWriterPausedRef.current = true
              pausedRef.current = true
              pauseStartedAtRef.current = Date.now()
              if (recorder?.state === 'recording') recorder.pause()
              setCaptureState('paused')
              setStatus(activeTranslate('stDiskWriteSlowPaused'))
              return
            }
            if (!pcmWriterPausedRef.current) return
            pcmWriterPausedRef.current = false
            pausedRef.current = false
            if (pauseStartedAtRef.current) pausedDurationRef.current += Date.now() - pauseStartedAtRef.current
            pauseStartedAtRef.current = null
            if (recorder?.state === 'paused') recorder.resume()
            setCaptureState('recording')
            setStatus(activeTranslate('stStagingCaughtUpResumed'))
          },
          (error) => {
            pcmWriterFailedRef.current = true
            pausedRef.current = true
            if (recorderRef.current?.state === 'recording') recorderRef.current.pause()
            setCaptureState('paused')
            setStatus(activeTranslate('stRecordingWriteFailedDetail').replace('{error}', String(error.message)))
          }
        )
      }
      if (opfsRecordingRef.current) {
        const recording = opfsRecordingRef.current
        const remoteRecording = remotePcmRecordingRef.current
        const limits = pcmRecordingBufferLimits(context.sampleRate, Boolean(remoteRecording))
        let writeStage: 'idle' | 'browser' | 'remote' = 'idle'
        const sink = createBrowserPcmSink({ recordingId: opfsRecordingIdRef.current!, recording, remoteRecording, onWriteStage: stage => { writeStage = stage } })
        pcmSinkRef.current = sink
        pcmWriterRef.current = new BufferedPcmWriter(
          audio => sink.append(audio),
          (active) => {
            const recorder = recorderRef.current
            if (active) {
              if (pcmWriterPausedRef.current) return
              pcmWriterPausedRef.current = true
              pausedRef.current = true
              pauseStartedAtRef.current = Date.now()
              if (recorder?.state === 'recording') recorder.pause()
              setCaptureState('paused')
              setStatus(activeTranslate(writeStage === 'remote' ? 'stRecordingUploadSlowPaused' : 'stBrowserStagingWriteSlowPaused'))
              return
            }
            if (!pcmWriterPausedRef.current) return
            pcmWriterPausedRef.current = false
            pausedRef.current = false
            if (pauseStartedAtRef.current) pausedDurationRef.current += Date.now() - pauseStartedAtRef.current
            pauseStartedAtRef.current = null
            if (recorder?.state === 'paused') recorder.resume()
            setCaptureState('recording')
            setStatus(activeTranslate('stBrowserStagingCaughtUp'))
          },
          (error) => {
            // Switching to RAM after an OPFS write failure would silently lose
            // the already-written prefix. Pause instead and preserve evidence.
            pcmWriterFailedRef.current = true
            pausedRef.current = true
            if (recorderRef.current?.state === 'recording') recorderRef.current.pause()
            setCaptureState('paused')
            setStatus(activeTranslate('stBrowserRecordingWriteFailedDetail').replace('{error}', String(error.message)))
          },
          limits.batchBytes,
          limits.maximumPendingBytes
        )
      }
      if (stream) attachInput(stream, context)
      if (systemStreamRef.current) attachSystemAudio(systemStreamRef.current, context)
      const continuation = continuationTargetRef.current
      const continuingCurrent = Boolean(continuation && liveSessionIdRef.current === continuation.entry.id)
      continuationEventIdsRef.current.clear()
      setTranscripts(continuation ? continuation.entry.segments : [])
      liveSessionIdRef.current = continuation?.entry.id ?? null
      if (!continuingCurrent) { setClearedThroughMs(-1); clearBoundaryRef.current = -1 }
      setTranscriptSearch(''); setSummaryText(''); setSummaryStatus(''); setFollowingCaptions(true)
      meterFrameRef.current = requestAnimationFrame(updateMeter)
      pausedRef.current = false
      const recorder = new MediaRecorder(recordingDestination.stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined })
      recorderRef.current = recorder
      recorder.start(1000)

      startAtRef.current = Date.now()
      activeDeviceIdRef.current = captureDeviceId
      pausedDurationRef.current = 0
      const elapsedBeforeContinuation = continuationTargetRef.current?.baseDurationMs ?? 0
      if (!continuingCurrent) setCaptionTimerOffsetMs(0)
      setElapsedMs(elapsedBeforeContinuation)
      timerRef.current = window.setInterval(() => setElapsedMs(elapsedBeforeContinuation + Date.now() - startAtRef.current - pausedDurationRef.current), 250)
      setCaptureState('recording')
      const sourceDescription = captureSystemAudio ? (stream ? activeTranslate('stMicAndSystemAudioMixing') : activeTranslate('stSystemAudioRecording')) : activeTranslate('stMicrophoneRecording')
      setStatus(preprocessingFallback || (captureModel.endpoint.trim() ? activeTranslate('stReceivingCaptionsFrom').replace('{source}', String(sourceDescription)).replace('{name}', String(captureModel.name)) : activeTranslate('stModelNotConnectedCaptionsPending').replace('{source}', String(sourceDescription))))
    } catch (error) {
      pcmWriterRef.current?.discard()
      pcmWriterRef.current = null
      remotePcmRecordingRef.current = null
      if (pcmSinkRef.current) void pcmSinkRef.current.abort().catch(() => undefined)
      else void opfsRecordingRef.current?.discard()
      opfsRecordingRef.current = null
      opfsRecordingIdRef.current = null
      if (!pcmSinkRef.current && electronRecordingIdRef.current) void window.s2t?.abortPcmRecording(electronRecordingIdRef.current)
      pcmSinkRef.current = null
      electronRecordingIdRef.current = null
      continuationTargetRef.current = null
      activeModelSnapshotRef.current = null
      if (liveDraftRef.current && !window.s2t) void remoteSessionStorage.deleteLiveDraft(liveDraftRef.current.id)
      liveDraftRef.current = null
      cleanUpCapture()
      void modelRef.current.stop()
      setCaptureState('idle')
      setStatus(error instanceof Error ? activeTranslate('stStartRecordingFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stStartRecordingFailed'))
    }
  }

const togglePause = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder) return
  if (pcmWriterFailedRef.current) {
      setStatus(activeTranslate('stRecordingWriteFailedStopAndRestart'))
    return
  }
  if (memoryRecordingLimitReachedRef.current) {
    setStatus(activeTranslate('stMemoryRecordingLimitReached'))
    return
  }
    if (pcmWriterPausedRef.current) {
      setStatus(activeTranslate('stWaitingForStagingWrite'))
      return
    }
    if (captureState === 'recording') {
      recorder.pause()
      pausedRef.current = true
      pauseStartedAtRef.current = Date.now()
      setCaptureState('paused')
      setStatus(activeTranslate('stPaused'))
      modelRef.current.flush?.()
    } else if (captureState === 'paused') {
      recorder.resume()
      pausedRef.current = false
      if (pauseStartedAtRef.current) pausedDurationRef.current += Date.now() - pauseStartedAtRef.current
      pauseStartedAtRef.current = null
      setCaptureState('recording')
      setStatus(activeTranslate('stRecording'))
    }
  }

const stopCapture = async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder || finishingSessionRef.current) return
    const captureEndedAt = Date.now()
    if (pauseStartedAtRef.current) {
      pausedDurationRef.current += captureEndedAt - pauseStartedAtRef.current
      pauseStartedAtRef.current = null
    }
    translationQueueRef.current!.paused = true
    setCaptureState('saving')
    pausedRef.current = true
    const continuation = continuationTargetRef.current
    const sessionId = continuation?.entry.id ?? crypto.randomUUID()
    const processingToken = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const capturedDurationMs = Math.max(0, captureEndedAt - startAtRef.current - pausedDurationRef.current)
    const durationMs = (continuation?.baseDurationMs ?? 0) + capturedDurationMs
    const microphoneName = selectedDeviceId === 'default' ? activeTranslate('systemDefaultMicrophone') : (devices.find((device) => device.deviceId === selectedDeviceId)?.label ?? activeTranslate('stSelectedAudioSource'))
    const source = selectedDeviceId === 'none' ? activeTranslate('computerAudio') : includeSystemAudio ? `${microphoneName} + ${activeTranslate('computerAudio')}` : microphoneName
    setTranscripts((current) => freezeCaptionGroups(current, true))
    const segments = transcriptsRef.current.filter((entry) => entry.status !== 'partial')
    const patchProcessing = (patch: Partial<SavedSession>): void => setSessions((current) => current.map((entry) => entry.id === sessionId && entry.processingToken === processingToken ? { ...entry, ...patch } : entry))
    finishingSessionRef.current = { id: sessionId, token: processingToken }
    const provisional: SavedSession = { ...continuation?.entry, id: sessionId,
      title: continuation?.entry.title ?? automaticSessionTitle(makeTranscriptText(segments), createdAt),
      createdAt: continuation?.entry.createdAt ?? createdAt, durationMs, source,
      transcript: makeTranscriptText(segments), segments, audioKey: continuation?.entry.audioKey || sessionId,
      processingToken, audioUnavailable: true, processingState: 'running', processingStage: 'asr', processingError: undefined, diarizationJobId: undefined }
    setSessions((current) => [provisional, ...current.filter((entry) => entry.id !== sessionId)])
    setHistorySearch('')
    setHistoryPage(1)
    setView('history')
    setStatus(activeTranslate('stRecordingStoppedBackgroundWork'))
    const finalTranslate = translationTransportRef.current!
    try {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        recorder.stop()
        cleanUpCapture()
      })
      const finalModelSamples = resamplerRef.current?.flush() ?? new Float32Array(0)
      if (finalModelSamples.length) {
        modelRef.current.pushAudio(finalModelSamples, sampleOffsetRef.current)
        sampleOffsetRef.current += finalModelSamples.length
      }
      resamplerRef.current = null
      await modelRef.current.stop()
      let translationDrainTimedOut = false
      if (translationQueueRef.current!.inFlight || (translationReady && settings.translationLoadStrategy !== 'manual')) {
        patchProcessing({ processingStage: 'translation' })
        setStatus(activeTranslate('stFinishingRemainingTranslation'))
        translationDrainTimedOut = !await translationQueueRef.current!.drain(
          { targetLanguage: settings.targetLanguage, strategy: settings.translationStrategy, elapsedMs: translationElapsedMsRef.current },
          finalTranslate, 60_000,
          translationReady && settings.translationLoadStrategy !== 'manual'
        )
      }
      console.info('s2t.capture.diagnostics', {
        asr: modelRef.current instanceof OpenAiChunkedModelAdapter ? modelRef.current.diagnostics : undefined,
        translation: translationQueueRef.current!.diagnostics,
        untranslated: transcriptsRef.current.filter((entry) => entry.status === 'final' && entry.sourceText.trim() && !entry.translatedText && entry.translationStatus !== 'completed' && !shouldSkipTranslation(entry.detectedLanguage, resolveTranslationTarget(entry.detectedLanguage, settings.targetLanguage))).length
      })
      patchProcessing({ processingStage: 'saving' })
      const audioKey = continuation ? continuation.entry.audioKey || sessionId : sessionId
      if (opfsRecordingRef.current && liveDraftRef.current) await opfsRecordingRef.current.saveRecoveryDraft({ ...liveDraftRef.current, updatedAt: new Date().toISOString(), captureState: 'paused', source, elapsedMs: durationMs, segments: transcriptsRef.current.filter(entry => entry.status !== 'partial'), opfsRecordingId: opfsRecordingIdRef.current!, sampleRate: sampleRateRef.current })
      await opfsRecordingRef.current?.setRecoveryTarget({ sessionId, audioKey, processingToken })
      if (pcmSinkRef.current) await pcmWriterRef.current?.closeAndDrain()
      const artifact = await pcmSinkRef.current?.finish()
      const remoteRecording = remotePcmRecordingRef.current
      remotePcmRecordingRef.current = null
      const recordingPath = artifact?.kind === 'local' ? artifact.audioPath : undefined
      electronRecordingIdRef.current = null
      const opfsRecording = opfsRecordingRef.current
      const blob = artifact?.kind === 'opfs' ? artifact.audio : recordingPath ? undefined : makeWav(pcmChunksRef.current, sampleRateRef.current)
      opfsRecordingRef.current = null
      opfsRecordingIdRef.current = null
      const name = `s2t-${new Date().toISOString().replace(/[:.]/g, '-')}`

      const capturedAudio = recordingPath && window.s2t ? new Blob([await window.s2t.readAudio(recordingPath)], { type: 'audio/wav' }) : blob
      const audioForStorage = continuation && capturedAudio ? await appendAudio(continuation.audio, capturedAudio) : capturedAudio
      // Final identification is independent of the live preview switch.
      const finalDiarizationRequired = Boolean(audioForStorage && settings.diarizationModel)
      const finalSegments = transcriptsRef.current.filter((entry) => entry.status !== 'partial')
      const transcript = makeTranscriptText(finalSegments)
      // A continuation rewrites the record's own audio key, so the finished
      // session stays one audio file (and one growing transcript) instead of
      // adding a version the user would have to pick from.
      const audioFailures: string[] = []
      let audioAvailable = Boolean(recordingPath)
      // Electron keeps durable audio locally. The web app writes durable audio
      // only to shared object storage; it never falls back to Browser Storage.
      if (audioForStorage && !window.s2t) {
        try { if (remoteRecording && !continuation) await remoteRecording.promote(audioKey); else await remoteSessionStorage.saveAudio(audioKey, audioForStorage); audioAvailable = true }
        catch {
          audioFailures.push(activeTranslate('sessionStorageRemote'))
        }
      }
      // All selected destinations have consumed the File-backed Blob. Remove
      // the temporary OPFS asset so a long recording does not accumulate files.
      const draftId = liveDraftRef.current?.id
      if (!window.s2t && (opfsRecording || remoteRecording)) sessionSyncRef.current?.registerCleanup(sessionId, audioKey, async () => {
          if (draftId) await remoteSessionStorage.deleteLiveDraft(draftId)
          await opfsRecording?.discard(); await remoteRecording?.discardCompleted()
      }, processingToken)
      if (!audioAvailable && audioForStorage) browserDownload(audioForStorage, `${name}.wav`)
      const modelSnapshot = activeModelSnapshotRef.current ?? continuation?.entry.modelSnapshot
      const sessionCreatedAt = continuation?.entry.createdAt ?? createdAt
      const version: AudioVersion = { id: 'original', audioKey, createdAt: sessionCreatedAt, label: activeTranslate('stOriginalRecording'), segments: finalSegments, transcript, modelSnapshot }
      const generatedTitle = automaticSessionTitle(transcript, sessionCreatedAt)
      // The merged continuation audio replaces the record's own file in place.
      const existingAudioPath = continuation ? continuation.entry.nativeAudioPath ?? activeAudioVersionFor(continuation.entry).nativeAudioPath : undefined
      // Electron persists each finished recording in its account directory;
      // session metadata and audio therefore never depend on Chromium storage.
      const desktopSession = window.s2t && audioForStorage
        ? await window.s2t.saveSession({
            name: generatedTitle,
            ...(continuation
              ? { audio: await audioForStorage.arrayBuffer(), recordingPath, ...(existingAudioPath ? { overwriteAudioPath: existingAudioPath } : {}) }
              : { recordingPath, audio: recordingPath ? undefined : await audioForStorage.arrayBuffer() }),
            transcript, createdAt: sessionCreatedAt, durationMs, source, segments: finalSegments
          })
        : undefined
      const processingError = translationDrainTimedOut ? activeTranslate('stProcessingTranslationTimeout')
        : finalSegments.some((entry) => entry.translationStatus === 'failed') ? activeTranslate('stProcessingPartialTranslationFailed')
        : audioFailures.length ? activeTranslate('stProcessingAudioSaveFailed') : undefined
      patchProcessing({ title: generatedTitle, durationMs, transcript, modelSnapshot, audioKey,
        audioVersions: [version], activeAudioVersionId: version.id,
        nativeAudioPath: desktopSession?.audioPath ?? existingAudioPath ?? recordingPath,
        savedToDisk: Boolean(desktopSession?.audioPath), audioUnavailable: !audioAvailable,
        segments: finalSegments, summary: undefined, summaryState: undefined, summarySourceSignature: undefined,
        summarySourceVersionId: undefined, summaryTranslation: undefined, summaryTranslationTargetLanguage: undefined, processingError,
        processingFailures: [...(translationDrainTimedOut || finalSegments.some(entry => entry.translationStatus === 'failed') ? ['translation' as const] : []), ...(audioFailures.length ? ['saving' as const] : []), ...(finalSegments.some(entry => entry.status === 'gap') ? ['asr' as const] : [])],
        processingState: finalDiarizationRequired && finalSegments.length ? 'running' : processingError || finalSegments.some(entry => entry.status === 'gap') ? 'failed' : 'completed',
        processingStage: finalDiarizationRequired && finalSegments.length ? 'diarization' : undefined })
      finishingSessionRef.current = null
      if (continuation) {
        // Everything the merged file superseded is released so one record never
        // leaves orphaned audio behind in either storage.
        const mergedAudioPath = desktopSession?.audioPath
        for (const superseded of audioVersionsFor(continuation.entry)) {
          if (superseded.audioKey && superseded.audioKey !== audioKey) void remoteSessionStorage.deleteAudio(superseded.audioKey).catch(() => undefined)
          if (window.s2t && mergedAudioPath && superseded.nativeAudioPath && superseded.nativeAudioPath !== mergedAudioPath) void window.s2t.deleteLocalAudio(superseded.nativeAudioPath).catch(() => undefined)
        }
        const previousPath = continuation.entry.nativeAudioPath
        if (window.s2t && mergedAudioPath && previousPath && previousPath !== mergedAudioPath) void window.s2t.deleteLocalAudio(previousPath).catch(() => undefined)
      }
      liveSessionIdRef.current = sessionId
      savedLiveSnapshotRef.current = transcriptsRef.current
      continuationTargetRef.current = null
      activeModelSnapshotRef.current = null
      // Preserve the draft as a recovery pointer until durable metadata ACK.
      liveDraftRef.current = null
      void generateSessionTitle(sessionId, transcript)
      setStatus(audioFailures.length ? activeTranslate('stRecordingEndedAudioSaveFailed').replace('{failures}', String(audioFailures.join(activeTranslate('stStorageDestinationJoinAnd')))) : activeTranslate('stRecordingEndedChooseSaveLocation'))
      if (translationDrainTimedOut) setStatus(activeTranslate('stRecordingSavedTranslationTimeout'))
      if (audioForStorage && finalDiarizationRequired && finalSegments.length) {
        if (!window.s2t && audioAvailable) {
          // The gateway owns this durable job. It waits/retries until the
          // session snapshot is visible, so closing this page cannot lose the
          // final tail after the last preview tick.
          void (async () => {
            try {
              const queued = await readJsonResponse<{ job?: { id?: string } }>(await authFetch('/api/data/diarization-jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, audioKey, processingToken, ...(settings.diarizationProfiles?.some(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint) ? { localModel: settings.diarizationModel } : {}) }) }), activeTranslate('stDiarizationJobScheduleLabel'))
              const jobId = queued.job?.id
              if (!jobId) throw new Error(activeTranslate('stGatewayMissingJobId'))
              if (!sessionsRef.current.some((entry) => entry.id === sessionId && entry.processingToken === processingToken)) {
                const canceled = await authFetch(`/api/data/diarization-jobs?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' })
                if (!canceled.ok) throw new Error(activeTranslate('stCancelRemovedSpeakerJob'))
                return
              }
              patchProcessing({ diarizationJobId: jobId })
            } catch (error) {
              patchProcessing({ processingState: 'failed', processingStage: undefined, processingFailures: [...new Set([...(sessionsRef.current.find(entry => entry.id === sessionId)?.processingFailures || []), 'diarization' as const])], processingError: error instanceof Error ? error.message : activeTranslate('stDiarizationJobFailed') })
              setStatus(error instanceof Error ? activeTranslate('stRecordingSavedDiarizationJobFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stRecordingSavedDiarizationJobFailed'))
            }
          })()
          return
        }
        const finalAudio = audioForStorage
        const targetVersionId = version.id
        void (async () => {
          try {
            const endpoint = window.s2t ? (settings.diarizationEndpoint.trim() || '/api/diarizations') : '/api/diarizations'
            const payload = window.s2t
              ? await window.s2t.diarizeAudio({ endpoint, model: settings.diarizationModel, audio: await finalAudio.arrayBuffer() })
              : await readJsonResponse<unknown>(await authFetch(endpoint, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-s2t-diarization-model': settings.diarizationProfiles?.some(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint) ? settings.diarizationModel : '', ...(settings.diarizationEndpoint.trim() && settings.diarizationEndpoint !== '/api/diarizations' ? { 'x-s2t-model-id': 'managed-diarization' } : {}) }, body: finalAudio }), activeTranslate('stDiarizationServiceLabel'))
            const turns = parseSpeakerTurns(payload)
            if (!turns.length) throw new Error(activeTranslate('stDiarizationNoSegments'))
            setSessions((current) => current.map((currentEntry) => {
              if (currentEntry.id !== sessionId || currentEntry.processingToken !== processingToken || currentEntry.activeAudioVersionId !== targetVersionId) return currentEntry
              const segments = assignSpeakersByOverlap(currentEntry.segments, turns)
              const updatedTranscript = makeTranscriptText(segments)
              const audioVersions = currentEntry.audioVersions?.map((item) => item.id === targetVersionId ? { ...item, segments, transcript: updatedTranscript } : item)
              return { ...currentEntry, segments, transcript: updatedTranscript, processingState: currentEntry.processingError || currentEntry.processingFailures?.length ? 'failed' : 'completed', processingStage: undefined, ...(audioVersions ? { audioVersions } : {}) }
            }))
          } catch (error) {
            patchProcessing({ processingState: 'failed', processingStage: undefined, processingFailures: [...new Set([...(sessionsRef.current.find(entry => entry.id === sessionId)?.processingFailures || []), 'diarization' as const])], processingError: error instanceof Error ? error.message : activeTranslate('stDiarizationFailed') })
            setStatus(error instanceof Error ? activeTranslate('stRecordingSavedDiarizationFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stRecordingSavedDiarizationFailed'))
          }
        })()
      }
    } catch (error) {
      patchProcessing({ processingState: 'failed', processingFailures: [...new Set([...(sessionsRef.current.find(entry => entry.id === sessionId)?.processingFailures || []), sessionsRef.current.find(entry => entry.id === sessionId)?.processingStage || 'saving'])], processingStage: undefined, processingError: error instanceof Error ? error.message : activeTranslate('stSessionSaveFailed') })
      await pcmSinkRef.current?.abort().catch(() => undefined)
      continuationTargetRef.current = null
      activeModelSnapshotRef.current = null
      setStatus(error instanceof Error ? activeTranslate('stSessionSaveFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stSessionSaveFailed'))
    } finally {
      finishingSessionRef.current = null
      cleanUpCapture()
      recorderRef.current = null
      pcmChunksRef.current = []
      memoryRecordingBytesRef.current = 0
      memoryRecordingLimitReachedRef.current = false
      pcmWriterRef.current = null
      pcmSinkRef.current = null
      pcmWriterPausedRef.current = false
      pcmWriterFailedRef.current = false
      electronRecordingIdRef.current = null
      setCaptureState('idle')
      setMicrophoneLevel(-60); setSystemLevel(-60)
    }
  }

const exportTranscript = (format: 'vtt' | 'json' | 'csv'): void => {
    const name = `s2t-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const content = format === 'vtt' ? makeVtt(transcripts) : format === 'csv' ? makeTranscriptCsv(transcripts) : format === 'json'
      ? JSON.stringify(transcripts, null, 2)
      : makeTranscriptText(transcripts)
    browserDownload(new Blob([content], { type: format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }), `${name}.${format}`)
    setStatus(activeTranslate('stSubtitleFileDownloaded').replace('{format}', String(format.toUpperCase())))
  }

const copyTranscript = async (entries: TranscriptEvent[], options?: { includeTimestamp?: boolean; includeSpeaker?: boolean; includeTranslation?: boolean }): Promise<void> => {
    const content = makeTranscriptText(entries, options)
    if (!content) { setStatus(activeTranslate('stNoTranscriptToCopy')); return }
    try { await navigator.clipboard.writeText(content); setStatus(activeTranslate('stLiveTranscriptCopied')) } catch { setStatus(activeTranslate('stCopyTranscriptFailed')) }
  }

const updateTranscript = (id: string, sourceText: string, translatedText: string): void => {
    setTranscripts((current) => current.map((entry) => entry.id === id
      ? editCaptionContent(entry, sourceText, translatedText)
      : entry))
  }

const updateSpeaker = (id: string, speaker: string): void => {
    setTranscripts((current) => current.map((entry) => entry.id === id ? { ...entry, speaker: speaker || undefined, speakerManuallyEdited: true } : entry))
  }

const renameLiveSpeaker = (from: string, to: string): void => {
    const previous = from.trim()
    const replacement = to.trim()
    if (!previous || !replacement) { setStatus(activeTranslate('stEnterSpeakerNames')); return }
    const changed = transcriptsRef.current.filter((entry) => entry.speaker === previous).length
    setTranscripts((current) => current.map((entry) => entry.speaker === previous
      ? { ...entry, speaker: replacement, speakerManuallyEdited: true }
      : entry))
    setStatus(changed ? activeTranslate('stSpeakerRenamedCount').replace('{count}', String(changed)).replace('{previous}', String(previous)).replace('{replacement}', String(replacement)) : activeTranslate('stSpeakerNotFound').replace('{name}', String(previous)))
  }

const sessionMutationBlocked = (id: string): boolean => {
    const blocked = qualityCorrectionActiveRef.current.has(id) || sessionsRef.current.find(entry => entry.id === id)?.processingState === 'running'
    if (blocked) setStatus(activeTranslate('stRecordStillProcessingInBackground'))
    return blocked
  }

const updateSessionSpeaker = (sessionId: string, segmentId: string, speaker: string): void => {
    if (sessionMutationBlocked(sessionId)) return
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) return session
      const segments = session.segments.map((segment) => segment.id === segmentId ? { ...segment, speaker: speaker || undefined, speakerManuallyEdited: true } : segment)
      const transcript = makeTranscriptText(segments)
      const audioVersions = session.audioVersions?.map((version) => version.id === session.activeAudioVersionId ? { ...version, segments, transcript } : version)
      return { ...session, title: automaticSessionTitle(transcript, session.createdAt), segments, transcript, ...(audioVersions ? { audioVersions } : {}) }
    }))
  }

const updateSavedTranscript = (sessionId: string, segmentId: string, update: { sourceText?: string; translatedText?: string }): void => {
    if (sessionMutationBlocked(sessionId)) return
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) return session
      const segments = session.segments.map((segment) => {
        if (segment.id !== segmentId) return segment
        const sourceText = update.sourceText ?? segment.sourceText
        const translatedText = update.translatedText === undefined ? segment.translatedText : update.translatedText || undefined
        return editCaptionContent(segment, sourceText, translatedText)
      })
      const transcript = makeTranscriptText(segments)
      const audioVersions = session.audioVersions?.map((version) => version.id === session.activeAudioVersionId ? { ...version, segments, transcript } : version)
      return { ...session, title: automaticSessionTitle(transcript, session.createdAt), segments, transcript, ...(audioVersions ? { audioVersions } : {}) }
    }))
  }

const updateSavedTranscriptTiming = (sessionId: string, segmentId: string, update: { startMs?: number; endMs?: number }): void => {
    if (sessionMutationBlocked(sessionId)) return
    const currentStart = update.startMs
    const currentEnd = update.endMs
    if ((currentStart !== undefined && (!Number.isFinite(currentStart) || currentStart < 0)) || (currentEnd !== undefined && !Number.isFinite(currentEnd))) { setStatus(activeTranslate('stInvalidTimingRange')); return }
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) return session
      const selected = session.segments.find((segment) => segment.id === segmentId)
      if (!selected) return session
      const startMs = Math.round(update.startMs ?? selected.startMs)
      const endMs = Math.round(update.endMs ?? selected.endMs)
      if (endMs <= startMs) { setStatus(activeTranslate('stInvalidTimingRange')); return session }
      const segments = session.segments.map((segment) => segment.id === segmentId
        ? { ...segment, startMs, endMs, revision: segment.revision + 1 }
        : segment).sort((left, right) => left.startMs - right.startMs)
      const transcript = makeTranscriptText(segments)
      const audioVersions = session.audioVersions?.map((version) => version.id === session.activeAudioVersionId ? { ...version, segments, transcript } : version)
      return { ...session, title: automaticSessionTitle(transcript, session.createdAt), segments, transcript, ...(audioVersions ? { audioVersions } : {}) }
    }))
  }

const updateTranscriptTiming = (id: string, startMs: number, endMs: number): void => {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) { setStatus(activeTranslate('stInvalidTimingRange')); return }
    setTranscripts((current) => current.map((entry) => entry.id === id ? { ...entry, startMs: Math.round(startMs), endMs: Math.round(endMs), revision: entry.revision + 1 } : entry))
  }

const saveSettings = (): void => {
    const markSaved = (): void => {
      setSettingsSaved(true)
      window.setTimeout(() => setSettingsSaved(false), 2400)
    }
    // Electron keeps the complete settings payload (including the glossary) in
    // its account-scoped local config.  Do not make a local-only workflow fail
    // merely because an external gateway has not been provisioned yet.
    if (window.s2t) {
      void window.s2t.saveModelConfig(settings).then(markSaved).catch(() => setStatus(activeTranslate('stLocalSettingsSaveFailed')))
      return
    }
    if (userRole === 'user') { markSaved(); return }
    void (async () => {
      const response = await retryableAuthFetch('/api/data/glossary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ glossary: settings.glossary, version: glossaryVersionRef.current ?? 0 }) })
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) }
      const saved = await response.json() as { version?: number }
      glossaryVersionRef.current = Number.isSafeInteger(saved.version) && saved.version! >= 0 ? saved.version! : glossaryVersionRef.current
      markSaved()
    })().catch((error: unknown) => setStatus(error instanceof Error ? activeTranslate('stGlossarySaveFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stGlossarySaveFailedSettingsKept')))
  }

const addModelProfile = async (capabilities?: ModelCapabilities): Promise<void> => {
    const name = newModelName.trim()
    const rawEndpoint = newModelEndpoint.trim()
    const model = newModelId.trim()
    if (!name || !rawEndpoint || !model) {
      setStatus(activeTranslate('stEnterModelProfileFields'))
      return
    }
    const kind: ModelProfile['kind'] = newModelUsesBuiltin ? 'openai-http' : 'websocket'
    if (window.s2t && kind === 'openai-http' && newModelRequiresApiKey && !newModelApiKey.trim()) {
      setStatus(activeTranslate('stOpenAiHttpModelNeedsApiKey'))
      return
    }
    const profile: ModelProfile = { id: crypto.randomUUID(), name, endpoint: modelEndpoint(rawEndpoint, kind), model, kind, requiresApiKey: newModelRequiresApiKey, capabilities: capabilities ?? (kind === 'openai-http' ? defaultHttpCapabilities : defaultWebSocketCapabilities) }
    try {
      if (newModelApiKey.trim()) await saveModelApiKey(profile.id, newModelApiKey.trim())
      setSettings((current) => {
        const next = { ...current, modelProfiles: [...current.modelProfiles, profile], selectedModelId: profile.id }
        if (window.s2t) void window.s2t.saveModelConfig(next).catch(() => setStatus(activeTranslate('stModelAddedSettingsSaveFailed')))
        return next
      })
      setNewModelName(''); setNewModelEndpoint(''); setNewModelId(''); setNewModelApiKey(''); setNewModelUsesBuiltin(false)
      setStatus(window.s2t ? activeTranslate('stModelSettingsSaved') : activeTranslate('stPreviewModeApiKeyNotSaved'))
    } catch (error) {
      setStatus(error instanceof Error ? activeTranslate('stAddModelFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stAddModelFailed'))
  }
}

const copySummary = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setStatus(activeTranslate('stMeetingSummaryCopied')) }
    catch { setStatus(activeTranslate('stCopyMeetingSummaryFailed')) }
  }

const updateSelectedModel = (update: Partial<ModelProfile>): void => {
    if (captureState !== 'idle') {
      setStatus(activeTranslate('asrModelLockedHint'))
      return
    }
    setSettings((current) => ({ ...current, modelProfiles: current.modelProfiles.map((profile) => profile.id === current.selectedModelId ? { ...profile, ...update } : profile) }))
  }

const selectTranslationProfile = (id: string): void => {
    setSettings((current) => {
      const profile = current.translationProfiles.find((item) => item.id === id)
      const next = profile
        ? { ...current, selectedTranslationModelId: id, translationEndpoint: profile.endpoint, translationModel: profile.model }
        : { ...current, selectedTranslationModelId: 'none' }
      // Electron keeps settings in the account config; persist the switch so it
      // survives a restart without requiring an explicit "save" click.
      if (window.s2t) void window.s2t.saveModelConfig(next).catch(() => setStatus(activeTranslate('stTranslationModelSwitchedSaveFailed')))
      return next
    })
  }

const saveTranslationProfile = (): void => {
    setSettings((current) => {
      if (!current.translationEndpoint.trim() || !current.translationModel.trim()) {
        setStatus(activeTranslate('stEnterTranslationEndpointModel'))
        return current
      }
      const existing = current.translationProfiles.find((item) => item.id === current.selectedTranslationModelId)
      const profile: TextModelProfile = existing
        ? { ...existing, endpoint: current.translationEndpoint.trim(), model: current.translationModel.trim(), name: activeTranslate('svcTranslationProfileName').replace('{model}', String(current.translationModel.trim())) }
        : { id: crypto.randomUUID(), name: activeTranslate('svcTranslationProfileName').replace('{model}', String(current.translationModel.trim())), endpoint: current.translationEndpoint.trim(), model: current.translationModel.trim() }
      const translationProfiles = existing ? current.translationProfiles.map((item) => item.id === profile.id ? profile : item) : [...current.translationProfiles, profile]
      return { ...current, translationProfiles, selectedTranslationModelId: profile.id }
    })
    setStatus(activeTranslate('stTranslationProfileAdded'))
  }

const removeSelectedModel = (): void => {
    if (selectedModel.id === 'none') return
    if (captureState !== 'idle') {
      setStatus(activeTranslate('stCannotDeleteAsrModelWhileRecording'))
      return
    }
    setSettings((current) => ({ ...current, modelProfiles: current.modelProfiles.filter((profile) => profile.id !== current.selectedModelId), selectedModelId: 'none' }))
  }

const saveApiKey = async (): Promise<void> => {
    if (selectedModel.kind !== 'openai-http') return
    if (!apiKeyDraft.trim()) { setApiKeyStatus(activeTranslate('stApiKeyPastePrompt')); return }
    try {
      await saveModelApiKey(selectedModel.id, apiKeyDraft.trim())
      setApiKeyDraft('')
      setApiKeyStatus(window.s2t ? activeTranslate('stApiKeySavedElectron') : activeTranslate('stApiKeySavedGateway'))
    } catch (error) {
      setApiKeyStatus(error instanceof Error ? error.message : activeTranslate('stApiKeySaveFailed'))
    }
  }

const openFloatingCaptions = (): void => {
    if (!window.s2t) {
      setWebCaptionFullscreenError('')
      if (captionPopoutRef.current && !captionPopoutRef.current.window.closed) { captionPopoutRef.current.window.focus(); return }
      if (captionPopoutOpeningRef.current) return
      captionPopoutOpeningRef.current = true
      const generation = captionPopoutGenerationRef.current
      void openCaptionPopout(() => {
        captionPopoutRef.current = null
        setWebCaptionPortalRoot(null); setWebCaptionWindow(null); setWebCaptionPopup(false); setWebCaptionFullscreen(false)
      }).then((popout) => {
        if (generation !== captionPopoutGenerationRef.current) { popout.dispose(); popout.window.close(); return }
        captionPopoutRef.current = popout
        setWebCaptionPortalRoot(popout.window.document.body)
        setWebCaptionWindow(popout.window); setWebCaptionIsPip(popout.pictureInPicture); setWebCaptionPopup(true)
        setStatus(popout.pictureInPicture ? activeTranslate('stPipCaptionsOpened') : activeTranslate('stStandaloneCaptionWindowOpened'))
      }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : activeTranslate('stPipCaptionsOpenFailed')))
        .finally(() => { captionPopoutOpeningRef.current = false })
      return
    }
    if (floatingCaptions) return
    setFloatingCaptions(true)
    window.s2t.toggleFloatingCaptions(true)
    setStatus(activeTranslate('stFloatingCaptionWindowOpened'))
  }

const closeFloatingCaptions = (): void => {
    window.s2t?.closeFloatingCaptions()
    setFloatingCaptions(false)
  }

const toggleFloatingCaptionFullscreen = (): void => {
    if (!window.s2t) return
    void window.s2t.toggleFloatingCaptionFullscreen().then(setFloatingCaptionFullscreen)
  }

const closeWebCaptionPopup = (): void => {
    setWebCaptionPortalRoot(null)
    captionPopoutRef.current?.dispose()
    captionPopoutRef.current?.window.close()
    captionPopoutRef.current = null
    setWebCaptionWindow(null)
    setWebCaptionPopup(false)
    setWebCaptionFullscreen(false)
  }

const toggleWebCaptionFullscreen = (): void => {
    setWebCaptionFullscreenError('')
    const popout = captionPopoutRef.current
    if (!popout || captionPopoutOpeningRef.current) return
    if (popout.pictureInPicture) {
      // Document PiP forbids fullscreen; keep captions in a separate window.
      captionPopoutOpeningRef.current = true
      const generation = captionPopoutGenerationRef.current
      let replacement: CaptionPopout | undefined
      void openCaptionPopout(() => {
        if (captionPopoutRef.current !== replacement) return
        captionPopoutRef.current = null
        setWebCaptionPortalRoot(null); setWebCaptionWindow(null)
        setWebCaptionPopup(false); setWebCaptionFullscreen(false)
      }, true).then((next) => {
        replacement = next
        if (generation !== captionPopoutGenerationRef.current || captionPopoutRef.current !== popout) {
          next.dispose(); next.window.close(); return
        }
        popout.dispose()
        captionPopoutRef.current = next
        setWebCaptionPortalRoot(next.window.document.body)
        setWebCaptionWindow(next.window); setWebCaptionIsPip(false)
        setWebCaptionFullscreen(false)
        next.window.focus()
        popout.window.close()
        return next.window.document.documentElement.requestFullscreen().catch(() => {
          if (captionPopoutRef.current === next) setWebCaptionFullscreenError(activeTranslate('stPressFullscreenInCaptionWindow'))
        })
      }).catch(() => setWebCaptionFullscreenError(activeTranslate('stCaptionWindowPopoutBlocked')))
        .finally(() => { captionPopoutOpeningRef.current = false })
      return
    }
    const doc = popout.window.document
    if (doc.fullscreenElement) { void doc.exitFullscreen(); return }
    void doc.documentElement.requestFullscreen().catch(() => setWebCaptionFullscreenError(activeTranslate('stPressFullscreenInCaptionWindow')))
  }

const selectImportFile = (file: File | null): void => {
    if (importProgress) return
    setImportedFile(null)
    setImportError('')
    if (!file) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    const acceptedExtensions = new Set<string>(importExtensions)
    if (!acceptedExtensions.has(extension ?? '')) {
      setImportError(activeTranslate('stUnsupportedFileExtension'))
      return
    }
    if (file.size === 0) {
      setImportError(activeTranslate('stEmptyFileNotImportable'))
      return
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      setImportError(activeTranslate('stFileExceedsTwoGigabytes'))
      return
    }
    setImportedFile(file)
  }

const transcribeImportedFile = async (): Promise<void> => {
    if (!importedFile || selectedModel.kind !== 'openai-http') {
      setImportError(activeTranslate('stSelectFileAndOpenAiAsrModel'))
      return
    }
    if (!window.s2t && !webGatewayAsrProfileId) {
      setImportError(interfaceTranslate(settings.uiLanguage, 'webGatewayModelRequired'))
      return
    }
    const supportedLanguages = selectedModel.capabilities.supportedLanguages ?? []
    if (settings.sourceLanguage !== 'auto' && supportedLanguages.length && !supportedLanguages.includes(settings.sourceLanguage)) {
      setImportError(activeTranslate('stModelMissingLanguage').replace('{name}', String(selectedModel.name)).replace('{language}', String(languageName(settings.sourceLanguage))))
      return
    }
    const isWav = importedFile.name.toLowerCase().endsWith('.wav')
    cancelImportRef.current = false
    setImportError(activeTranslate('stPreparingBatchTranscription'))
    try {
      // Do not read a long WAV into renderer memory. Its header is read once;
      // each ASR request then owns only one 45-second segment plus overlap.
      setImportProgress({ current: 0, total: 1 })
      let wavFile = importedFile
      let wavLayout
      if (isWav) {
        try { wavLayout = await readPcmWavFileLayout(wavFile) } catch { /* Other WAV encodings are converted below. */ }
      }
      if (!wavLayout) {
        setImportError(interfaceTranslate(settings.uiLanguage, 'convertingImport'))
        const controller = new AbortController()
        importAbortRef.current = controller
        try {
          const converted = await authFetch('/api/audio-processing/import-wav', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: importedFile, signal: controller.signal })
          if (!converted.ok) {
            const detail = await converted.json().catch(() => ({})) as { error?: string }
            throw new Error(detail.error || activeTranslate('stImportConversionFailedHttp').replace('{status}', String(converted.status)))
          }
          const blob = await converted.blob()
          if (cancelImportRef.current) throw new Error(activeTranslate('stBatchTranscriptionCancelled'))
          wavFile = new File([blob], 'converted.wav', { type: 'audio/wav' })
          wavLayout = await readPcmWavFileLayout(wavFile)
        } finally { if (importAbortRef.current === controller) importAbortRef.current = null }
      }
      if (cancelImportRef.current) throw new Error(activeTranslate('stBatchTranscriptionCancelled'))
      const totalChunks = pcmWavChunkCount(wavLayout)
      const fingerprint = importFileFingerprint(importedFile)
      const modelSnapshot = importModelSnapshot(selectedModel)
      const checkpoint = !window.s2t ? await remoteSessionStorage.loadImportCheckpoint() : undefined
      const checkpointMatches = matchesImportCheckpoint(checkpoint, { fingerprint, modelId: selectedModel.id, modelSnapshot, sourceLanguage: settings.sourceLanguage, prompt: settings.glossary, totalChunks })
      let wavStartByte = checkpointMatches ? checkpoint!.nextByteOffset : 0
      const segments: TranscriptEvent[] = checkpointMatches ? checkpoint!.segments : []
      let merged = checkpointMatches ? checkpoint!.mergedText : ''
      const firstChunkIndex = checkpointMatches ? checkpoint!.nextChunkIndex : 0
      if (checkpointMatches) setImportError(activeTranslate('stImportResumedFromCheckpoint').replace('{index}', String(firstChunkIndex + 1)).replace('{total}', String(totalChunks)))
      setImportProgress({ current: firstChunkIndex, total: totalChunks })
      // Four bounded requests keep vLLM supplied without loading the whole
      // file. Only ordered, contiguous results advance the durable checkpoint.
      await orderedWindow({ start: firstChunkIndex, end: totalChunks, concurrency: 4,
        cancelled: () => cancelImportRef.current,
        produce: async index => {
        if (cancelImportRef.current) throw new Error(activeTranslate('stBatchCancelledCompletedKept'))
        const startByte = wavStartByte
        const nextByteOffset = nextPcmWavChunkStart(wavLayout, startByte)
        wavStartByte = nextByteOffset
        const chunk = await readPcmWavFileChunk(wavFile, wavLayout, startByte)
        const targetSampleRate = wavLayout ? chooseModelSampleRate(wavLayout.sampleRate, selectedModel.capabilities.supportedSampleRates ?? []) : undefined
        const asrAudio = wavLayout && targetSampleRate !== undefined && targetSampleRate !== wavLayout.sampleRate
          ? await resampleAudioForAsr(chunk.audio, targetSampleRate)
          : chunk.audio
        let response: { text: string } | undefined
        let lastError: unknown
        for (const delay of [0, 400, 1_200]) {
          if (delay) await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
          if (cancelImportRef.current) throw new Error(activeTranslate('stBatchTranscriptionCancelled'))
          try {
            response = window.s2t ? await window.s2t.transcribeAudioChunk({
              profileId: selectedModel.id, endpoint: selectedModel.endpoint, model: selectedModel.model,
              language: asrLanguage(settings.sourceLanguage), requiresApiKey: selectedModel.requiresApiKey !== false, prompt: settings.glossary || undefined,
              filename: `batch-${index + 1}.wav`, contentType: 'audio/wav', audio: asrAudio
            }) : await (() => {
              const controller = new AbortController()
              importRequestsRef.current.add(controller)
              return requestBrowserAsr({ method: 'POST', headers: {
              'content-type': 'audio/wav',
              'x-s2t-filename': headerValue(`batch-${index + 1}.wav`),
              ...(webGatewayAsrProfileId ? { 'x-s2t-model-id': webGatewayAsrProfileId } : {}),
              ...(asrLanguage(settings.sourceLanguage) ? { 'x-s2t-language': asrLanguage(settings.sourceLanguage) } : {}),
              ...(settings.glossary ? { 'x-s2t-prompt': headerValue(settings.glossary) } : {})
            }, body: asrAudio }, controller).finally(() => { importRequestsRef.current.delete(controller) })
            })().then(async (result) => {
              const payload = await readJsonResponse<{ text?: string; error?: string }>(result, activeTranslate('stBatchAsrGatewayLabel'))
              if (!result.ok) throw new Error(payload.error || `HTTP ${result.status}`)
              return { text: payload.text || '' }
            })
            break
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') throw new Error(cancelImportRef.current ? activeTranslate('stBatchTranscriptionCancelled') : activeTranslate('stBatchAsrRequestTimeout'))
            lastError = error
          }
        }
        if (!response) throw lastError instanceof Error ? lastError : new Error(activeTranslate('stChunkTranscriptionFailed').replace('{index}', String(index + 1)))
        return { chunk, response, nextByteOffset }
        },
        commit: async ({ chunk, response, nextByteOffset }, index) => {
        const mergedNext = joinOverlappedText(merged, response.text)
        const appended = mergedNext.slice(merged.length).trim()
        if (appended) segments.push({ id: crypto.randomUUID(), revision: 1, status: 'final', startMs: chunk.startMs, endMs: chunk.endMs, sourceText: appended })
        merged = mergedNext
        if (wavLayout && !window.s2t) await remoteSessionStorage.saveImportCheckpoint({ fingerprint, modelId: selectedModel.id, modelSnapshot, sourceLanguage: settings.sourceLanguage, prompt: settings.glossary, nextChunkIndex: index + 1, nextByteOffset, totalChunks, segments, mergedText: merged, updatedAt: new Date().toISOString() })
        setImportProgress({ current: index + 1, total: totalChunks })
        }
      })
      if (!segments.length) { if (wavLayout && !window.s2t) await remoteSessionStorage.deleteImportCheckpoint(); throw new Error(activeTranslate('stModelReturnedNoTranscript')) }
      if (wavLayout && !window.s2t) await remoteSessionStorage.deleteImportCheckpoint()
      setTranscripts(segments)
      liveSessionIdRef.current = null
      setImportError(activeTranslate('stBatchTranscriptionCompleted'))
      setView('live')
    } catch (error) { setImportError(cancelImportRef.current ? activeTranslate('stBatchTranscriptionCancelled') : error instanceof Error ? error.message : activeTranslate('stImportTranscriptionFailed')) } finally { importAbortRef.current = null; setImportProgress(null); cancelImportRef.current = false }
  }

const cancelImport = (): void => {
    cancelImportRef.current = true
    importAbortRef.current?.abort()
    for (const controller of importRequestsRef.current) controller.abort()
    setImportError(activeTranslate('stCancellingCurrentUpload'))
  }

const audioVersionsFor = (entry: SavedSession): AudioVersion[] => entry.audioVersions?.length ? entry.audioVersions : [{ id: 'original', audioKey: entry.audioKey, createdAt: entry.createdAt, label: activeTranslate('stOriginalRecording'), segments: entry.segments, transcript: entry.transcript }]
const activeAudioVersionFor = (entry: SavedSession): AudioVersion => audioVersionsFor(entry).find((version) => version.id === entry.activeAudioVersionId) ?? audioVersionsFor(entry)[0]
const loadSessionAudio = async (entry: SavedSession, attempts = 3): Promise<Blob | undefined> => {
    const version = activeAudioVersionFor(entry)
    if (version.nativeAudioPath && window.s2t) return new Blob([await window.s2t.readAudio(version.nativeAudioPath)], { type: 'audio/wav' })
    if (entry.nativeAudioPath && window.s2t && version.audioKey === entry.audioKey) return new Blob([await window.s2t.readAudio(entry.nativeAudioPath)], { type: 'audio/wav' })
    if (!window.s2t) return remoteSessionStorage.loadAudio(version.audioKey, attempts)
    return remoteSessionStorage.loadAudio(version.audioKey, attempts)
  }
const retryFailedSession = async (entry: SavedSession, backup?: File, legacyStage?: 'asr' | 'translation' | 'diarization' | 'saving'): Promise<void> => {
  await retrySession({
    desktop: window.s2t, settings, selectedModel, webGatewayAsrProfileId,
    activeRecoveries: recoveryActiveRef.current, qualityCorrectionActive: qualityCorrectionActiveRef.current,
    loadSessionAudio, audioVersionsFor, activeAudioVersionFor, resampleAudioForAsr, requestBrowserAsr, authFetch,
    saveAudio: remoteSessionStorage.saveAudio,
    translate: (segment, signal, timeout) => translationTransportRef.current!(segment, signal, timeout ?? 90_000, 'background'),
    publish: (updated, previousToken, token) => setSessions(current => current.map(item =>
      item.id === updated.id && (item.processingToken === token || item.processingToken === previousToken) ? updated : item)),
    setStatus, activeTranslate
  }, entry, backup, legacyStage)
}
const transcribeCorrection = async (data: ArrayBuffer, model = selectedModel, language = settings.sourceLanguage, prompt = settings.glossary): Promise<{ text: string }> => {
    const profileId = gatewayAsrProfileId(model.id)
    return window.s2t ? await window.s2t.transcribeAudioChunk({ profileId: model.id, endpoint: model.endpoint, model: model.model, language: asrLanguage(language), requiresApiKey: model.requiresApiKey !== false, prompt: prompt || undefined, filename: `correction.wav`, contentType: 'audio/wav', audio: data }) : await requestBrowserAsr({ method: 'POST', headers: { 'content-type': 'audio/wav', 'x-s2t-filename': headerValue(`correction.wav`), ...(profileId ? { 'x-s2t-model-id': profileId } : {}), ...(asrLanguage(language) ? { 'x-s2t-language': asrLanguage(language) } : {}), ...(prompt ? { 'x-s2t-prompt': headerValue(prompt) } : {}) }, body: data }).then(async (response) => { const body = await readJsonResponse<{ text?: string; error?: string }>(response, activeTranslate('stFinalAsrServiceLabel')); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return { text: body.text || '' } })
  }

liveCorrectionRunnerRef.current = async (): Promise<void> => {
    const buffer = liveCorrectionAudioRef.current
    const model = activeModelSnapshotRef.current
    if (isFloatingCaptionWindow || liveCorrectionBusyRef.current || captureState !== 'recording' ||
        !buffer || buffer.samples / buffer.sampleRate < 30 || model?.kind !== 'openai-http') return
    const epoch = liveCorrectionEpochRef.current
    const baseMs = continuationTargetRef.current?.baseDurationMs ?? 0
    const groups = correctionGroups(transcriptsRef.current).filter(group => group.startMs >= baseMs &&
      !liveCorrectionDoneRef.current.has(captionGroupSignature(group)) && group.members.every(member => member.correctionOriginalText === undefined))
    const group = groups.find(item => (liveCorrectionFailuresRef.current.get(captionGroupSignature(item)) ?? 0) <= Date.now())
    if (!group) return
    const signature = captionGroupSignature(group)
    const samples = buffer.slice(group.startMs - baseMs, group.endMs - baseMs)
    if (!samples) { liveCorrectionDoneRef.current.add(signature); setStatus(activeTranslate('liveCorrectionAudioExpired')); return }
    liveCorrectionBusyRef.current = true
    try {
      const wav = await makeWav([samples], buffer.sampleRate).arrayBuffer()
      const result = await transcribeCorrection(wav, { ...selectedModel, ...model }, model.sourceLanguage, model.prompt)
      if (epoch !== liveCorrectionEpochRef.current) return
      if (!result.text.trim()) throw new Error(activeTranslate('stAsrReturnedNoTranscript'))
      setTranscripts(current => applySentenceCorrection(current, group, result.text.trim()))
      liveCorrectionDoneRef.current.add(signature)
    } catch (error) {
      if (epoch === liveCorrectionEpochRef.current) {
        liveCorrectionFailuresRef.current.set(signature, Date.now() + 30_000)
        setStatus(activeTranslate('stQualityCorrectionFailedDetail').replace('{error}', error instanceof Error ? error.message : String(error)))
      }
    } finally { liveCorrectionBusyRef.current = false }
  }

useEffect(() => {
    if (captureState !== 'recording' || isFloatingCaptionWindow) return
    const timer = window.setInterval(() => void liveCorrectionRunnerRef.current(), 1000)
    return () => window.clearInterval(timer)
  }, [captureState, isFloatingCaptionWindow])

const finalizeSession = async (entry: SavedSession, items: ComparisonKind[] = ['transcript', 'diarization']): Promise<void> => {
    if (!items.length) return
    const doAsr = items.includes('transcript'), doDiarization = items.includes('diarization'), doTranslation = items.includes('translation')
    if (entry.processingState === 'running' || qualityCorrectionActiveRef.current.has(entry.id)) { setStatus(activeTranslate('stRecordStillProcessing')); return }
    if (doAsr && selectedModel.kind !== 'openai-http') { setStatus(activeTranslate('stSelectOpenAiCompatibleAsrModel')); return }
    if (doDiarization && !settings.diarizationModel) { setStatus(activeTranslate('stDiarizationModelRequired')); return }
    if (doTranslation && !settings.translationModel) { setStatus(activeTranslate('stTranslationModelRequired')); return }
    qualityCorrectionActiveRef.current.add(entry.id)
    // One controller for the whole run: an early failure tears down the request
    // already in flight instead of leaving it to finish against a dead record.
    const abort = new AbortController()
    const progress = (stage: 'loading' | 'asr' | 'diarization' | 'translation' | 'completed', completed = 0, total = 0): void => {
      setQualityCorrectionProgress(current => ({ ...current, [entry.id]: { stage, completed, total } }))
    }
    progress('loading')
    try {
      const audio = doAsr || doDiarization ? await loadSessionAudio(entry) : null
      if ((doAsr || doDiarization) && !audio) throw new Error(activeTranslate('stFullWavRecordingNotFound'))
      const groups = doAsr ? correctionGroups(entry.segments, true) : []
      if (doAsr && !groups.length) throw new Error(activeTranslate('stAsrReturnedNoTranscript'))
      const total = groups.length + Number(doDiarization) + Number(doTranslation)
      let completed = 0
      let segments: TranscriptEvent[] = entry.segments.map(segment => ({ ...segment }))
      if (doAsr && audio) {
        const file = new File([audio], 'finalization.wav', { type: 'audio/wav' })
        const layout = await readPcmWavFileLayout(file)
        segments = []
        progress('asr', 0, total)
        for (const group of groups) {
          const chunk = await readPcmWavSentence(file, layout, group.startMs, group.endMs)
          const rate = chooseModelSampleRate(layout.sampleRate, selectedModel.capabilities.supportedSampleRates ?? [])
          const data = rate === layout.sampleRate ? chunk.audio : await resampleAudioForAsr(chunk.audio, rate)
          const asr = await transcribeCorrection(data)
          if (!asr.text.trim()) throw new Error(activeTranslate('stAsrReturnedNoTranscript'))
          segments.push(correctedCaption(group, asr.text.trim()))
          progress('asr', ++completed, total)
        }
        const groupedIds = new Set(groups.flatMap(group => group.members.map(member => member.id)))
        segments = [...segments, ...entry.segments.filter(segment => !groupedIds.has(segment.id))].sort((a,b) => a.startMs - b.startMs)
      }
      if (doDiarization && audio) {
        progress('diarization', completed, total)
        let diarized: unknown
        if (window.s2t) diarized = await window.s2t.diarizeAudio({ endpoint: settings.diarizationEndpoint, model: settings.diarizationModel, audio: await audio.arrayBuffer() })
        else {
          const local = settings.diarizationProfiles?.some(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint)
          const response = await authFetch('/api/diarizations', { method: 'POST', headers: { 'content-type': 'audio/wav', ...(local ? { 'x-s2t-diarization-model': settings.diarizationModel } : settings.diarizationEndpoint && settings.diarizationEndpoint !== '/api/diarizations' ? { 'x-s2t-model-id': 'managed-diarization' } : {}) }, body: audio, signal: AbortSignal.timeout(120000) })
          const payload = await readJsonResponse<{ error?: string }>(response, activeTranslate('stFinalDiarizationServiceLabel'))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
          diarized = payload
        }
        const turns = parseSpeakerTurns(diarized)
        if (!turns.length) throw new Error(activeTranslate('stDiarizationNoSpeakerSegments'))
        segments = assignSpeakersByOverlap(segments, turns).map((segment,index) => segments[index].speakerManuallyEdited ? { ...segment, speaker: segments[index].speaker } : segment)
        progress('diarization', ++completed, total)
      }
      if (doTranslation) {
        progress('translation', completed, total)
        const translate = translationTransportRef.current!
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index]
          if (segment.status !== 'final' || !segment.sourceText.trim()) continue
          // A single shared signal: it outlives no request, and any future
          // cancellation of this run reaches every segment at once.
          const result = await translate(segment, abort.signal, 90_000, 'background')
          if (!result.text.trim()) throw new Error(activeTranslate('stTranslationServiceEmpty'))
          segments[index] = { ...segment, translatedText: result.text, translationStatus: 'completed' }
        }
        progress('translation', ++completed, total)
      }
      const transcript = makeTranscriptText(segments)
      const correctedVersionId = crypto.randomUUID()
      // Only a re-transcription produces a title worth regenerating. A
      // diarization-only or translation-only pass leaves the transcript the
      // user already named untouched.
      setSessions((current) => current.map((item) => item.id === entry.id ? { ...item, qualityCorrectionState: 'completed', qualityCorrectionError: undefined, ...(doAsr ? { title: automaticSessionTitle(transcript, item.createdAt) } : {}), transcript, segments, audioVersions: [...audioVersionsFor(item), { ...activeAudioVersionFor(item), id: correctedVersionId, audioKey: activeAudioVersionFor(item).audioKey, createdAt: new Date().toISOString(), label: activeTranslate('qualityCorrection'), parentId: activeAudioVersionFor(item).id, segments, transcript }], activeAudioVersionId: correctedVersionId } : item))
      if (doAsr) void generateSessionTitle(entry.id, transcript)
      progress('completed', total, total)
      setStatus(activeTranslate('stFullRecordingCorrectionCompleted'))
    } catch (error) {
      const message = error instanceof Error ? error.message : activeTranslate('stQualityCorrectionFailed')
      setQualityCorrectionProgress((current) => ({ ...current, [entry.id]: {
        ...current[entry.id], stage: 'failed', error: message
      } }))
      setSessions((current) => current.map((item) => item.id === entry.id ? { ...item, qualityCorrectionState: 'failed', qualityCorrectionError: message } : item))
      setStatus(activeTranslate('stQualityCorrectionFailedDetail').replace('{error}', String(message)))
    } finally { qualityCorrectionActiveRef.current.delete(entry.id); abort.abort() }
  }
const appendAudio = async (first: Blob, second: Blob): Promise<Blob> => {
    const context = new AudioContext()
    try {
      const [left, right] = await Promise.all([context.decodeAudioData(await first.arrayBuffer()), context.decodeAudioData(await second.arrayBuffer())])
      const sampleRate = left.sampleRate
      const output = new OfflineAudioContext(Math.max(left.numberOfChannels, right.numberOfChannels), Math.ceil((left.duration + right.duration) * sampleRate), sampleRate)
      const firstSource = output.createBufferSource(); firstSource.buffer = left; firstSource.connect(output.destination); firstSource.start(0)
      const secondSource = output.createBufferSource(); secondSource.buffer = right; secondSource.connect(output.destination); secondSource.start(left.duration)
      const rendered = await output.startRendering()
      const mono = new Float32Array(rendered.length)
      for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) { const samples = rendered.getChannelData(channel); for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / rendered.numberOfChannels }
      return makeWav([mono], rendered.sampleRate)
    } finally { await context.close().catch(() => undefined) }
}
/** Decode, downmix and resample one bounded import/rerecord request for ASR. */
const resampleAudioForAsr = async (audio: ArrayBuffer, sampleRate: number): Promise<ArrayBuffer> => {
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(audio)
      if (decoded.sampleRate === sampleRate && decoded.numberOfChannels === 1) return makeWav([decoded.getChannelData(0)], decoded.sampleRate).arrayBuffer()
      const output = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * sampleRate)), sampleRate)
      const source = output.createBufferSource(); source.buffer = decoded; source.connect(output.destination); source.start()
      const rendered = await output.startRendering()
      return makeWav([rendered.getChannelData(0)], sampleRate).arrayBuffer()
    } finally { await context.close().catch(() => undefined) }
  }
const audioDurationMs = async (audio: Blob, fallback: number): Promise<number> => {
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(await audio.arrayBuffer())
      return Math.max(0, Math.round(decoded.duration * 1000))
    } catch { return fallback } finally { await context.close().catch(() => undefined) }
  }
const continueSession = async (entry: SavedSession, audioChoice?: CaptureAudioChoice): Promise<void> => {
    if (entry.processingState === 'running' || qualityCorrectionActiveRef.current.has(entry.id)) { setStatus(activeTranslate('stRecordStillProcessing')); return }
    if (captureState !== 'idle') { setStatus(activeTranslate('stStopCurrentRecordingFirst')); return }
    try {
      const prepared = continuationTargetRef.current
      const reusable = prepared?.entry.id === entry.id && prepared.entry.audioKey === entry.audioKey && prepared.entry.activeAudioVersionId === entry.activeAudioVersionId
      const audio = reusable ? prepared.audio : await loadSessionAudio(entry)
      if (!audio) throw new Error(activeTranslate('stSelectedAudioVersionNotFound'))
      continuationTargetRef.current = { entry, audio, baseDurationMs: reusable ? prepared.baseDurationMs : await audioDurationMs(audio, entry.durationMs) }
      // Continuation uses the live capture workspace. Move there before asking
      // for audio permission so the recording state and any prompt are visible.
      setView('live')
      await startCapture(audioChoice)
    } catch (error) { continuationTargetRef.current = null; setStatus(error instanceof Error ? activeTranslate('stContinueRecordingFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stContinueRecordingFailed')) }
  }
const startOrContinueRecording = async (audioChoice?: CaptureAudioChoice): Promise<void> => {
    const existing = sessions.find((entry) => entry.id === liveSessionIdRef.current)
    if (existing) await continueSession(existing, audioChoice)
    else await startCapture(audioChoice)
  }
const selectAudioVersion = (sessionId: string, versionId: string): void => {
    setSessions((current) => current.map((entry) => {
      if (entry.id !== sessionId) return entry
      const version = audioVersionsFor(entry).find((item) => item.id === versionId)
      if (!version) return entry
      const transcript = version.segments ? version.transcript ?? makeTranscriptText(version.segments) : entry.transcript
      return { ...entry, activeAudioVersionId: versionId, title: automaticSessionTitle(transcript, entry.createdAt), ...(version.segments ? { segments: version.segments, transcript } : {}) }
    }))
    setStatus(activeTranslate('stAudioVersionSwitched'))
  }
const replaceSessionSegmentAudio = async (entry: SavedSession, segment: TranscriptEvent, replacement: Blob): Promise<void> => {
    if (sessionMutationBlocked(entry.id)) return
    if (!replacement.size) { setStatus(activeTranslate('stRerecordAudioEmpty')); return }
    try {
      setStatus(activeTranslate('stCreatingRerecordVersion'))
      const original = await loadSessionAudio(entry)
      if (!original) throw new Error(activeTranslate('stCurrentAudioVersionNotFound'))
      const context = new AudioContext()
      const [originalBuffer, replacementBuffer] = await Promise.all([context.decodeAudioData(await original.arrayBuffer()), context.decodeAudioData(await replacement.arrayBuffer())])
      const start = Math.max(0, segment.startMs / 1000)
      const end = Math.min(originalBuffer.duration, segment.endMs / 1000)
      if (end <= start) throw new Error(activeTranslate('stSegmentTimeRangeNotReplaceable'))
      const output = new OfflineAudioContext(originalBuffer.numberOfChannels, Math.ceil(originalBuffer.duration * originalBuffer.sampleRate), originalBuffer.sampleRate)
      const before = output.createBufferSource(); before.buffer = originalBuffer; before.connect(output.destination); if (start > 0) before.start(0, 0, start)
      const rerecorded = output.createBufferSource(); rerecorded.buffer = replacementBuffer; rerecorded.connect(output.destination); rerecorded.start(start, 0, Math.min(replacementBuffer.duration, end - start))
      const after = output.createBufferSource(); after.buffer = originalBuffer; after.connect(output.destination); if (end < originalBuffer.duration) after.start(end, end, originalBuffer.duration - end)
      const rendered = await output.startRendering()
      // ASR must receive exactly the audio placed in the fixed time slot:
      // overlong takes are cropped and short takes retain their trailing
      // silence, matching the newly stored version byte-for-byte in timing.
      const slot = new OfflineAudioContext(1, Math.ceil((end - start) * originalBuffer.sampleRate), originalBuffer.sampleRate)
      const slotSource = slot.createBufferSource(); slotSource.buffer = replacementBuffer; slotSource.connect(slot.destination); slotSource.start(0, 0, Math.min(replacementBuffer.duration, end - start))
      const renderedSlot = await slot.startRendering()
      await context.close()
      const mono = new Float32Array(rendered.length)
      for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) { const samples = rendered.getChannelData(channel); for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / rendered.numberOfChannels }
      const audio = makeWav([mono], rendered.sampleRate)
      const asrAudioRaw = makeWav([renderedSlot.getChannelData(0)], renderedSlot.sampleRate)
      const asrSampleRate = chooseModelSampleRate(renderedSlot.sampleRate, selectedModel.capabilities.supportedSampleRates ?? [])
      const asrAudio = asrSampleRate === renderedSlot.sampleRate
        ? await asrAudioRaw.arrayBuffer()
        : await resampleAudioForAsr(await asrAudioRaw.arrayBuffer(), asrSampleRate)
      const versionId = crypto.randomUUID(); const audioKey = `${entry.id}-version-${versionId}`; const createdAt = new Date().toISOString()
      const failures: string[] = []
      let writes = 0
      let nativeAudioPath: string | undefined
      // Web writes only shared object storage. Electron local audio is written
      // by the main process, never by renderer IndexedDB.
      if (window.s2t && settings.storageLocation === 'local') { writes += 1; try { nativeAudioPath = (await window.s2t.saveLocalAudio(audioKey, await audio.arrayBuffer())).audioPath } catch { failures.push(activeTranslate('local')) } }
      if (!window.s2t || settings.storageLocation === 'remote') { writes += 1; try { await remoteSessionStorage.saveAudio(audioKey, audio) } catch { failures.push(activeTranslate('sessionStorageRemote')) } }
      if (failures.length === writes) throw new Error(activeTranslate('stRerecordAllLocationsSaveFailed').replace('{locations}', String(failures.join(activeTranslate('stFailedLocationsJoiner')))))
      const parent = activeAudioVersionFor(entry)
      const version: AudioVersion = { id: versionId, audioKey, createdAt, label: activeTranslate('stRerecordVersionLabel').replace('{time}', String(timestamp(segment.startMs))), parentId: parent.id, replacedSegmentId: segment.id, nativeAudioPath, segments: entry.segments, transcript: entry.transcript }
      setSessions((current) => current.map((item) => item.id === entry.id ? { ...item, audioVersions: [...audioVersionsFor(item), version], activeAudioVersionId: version.id, nativeAudioPath: undefined, audioUnavailable: false } : item))
      setStatus(failures.length ? activeTranslate('stRerecordVersionSyncFailed').replace('{locations}', String(failures.join(activeTranslate('stFailedLocationsJoiner')))) : activeTranslate('stRerecordVersionCreated'))
      const supportedLanguages = selectedModel.capabilities.supportedLanguages ?? []
      if (selectedModel.id !== 'none' && (settings.sourceLanguage === 'auto' || !supportedLanguages.length || supportedLanguages.includes(settings.sourceLanguage))) {
        try {
          const result = window.s2t
            ? await window.s2t.transcribeAudioChunk({ profileId: selectedModel.id, endpoint: selectedModel.endpoint, model: selectedModel.model, language: asrLanguage(settings.sourceLanguage), requiresApiKey: selectedModel.requiresApiKey !== false, prompt: settings.glossary || undefined, filename: 'segment-rerecord.wav', contentType: 'audio/wav', audio: asrAudio })
            : await readJsonResponse<{ text?: string }>(await requestBrowserAsr({ method: 'POST', headers: { 'content-type': 'audio/wav', 'x-s2t-filename': headerValue('segment-rerecord.wav'), ...(webGatewayAsrProfileId ? { 'x-s2t-model-id': webGatewayAsrProfileId } : {}), ...(asrLanguage(settings.sourceLanguage) ? { 'x-s2t-language': asrLanguage(settings.sourceLanguage) } : {}), ...(settings.glossary ? { 'x-s2t-prompt': headerValue(settings.glossary) } : {}) }, body: asrAudio }), activeTranslate('stRerecordAsrService'))
          const sourceText = result.text?.trim()
          if (sourceText) {
            updateSavedTranscript(entry.id, segment.id, { sourceText })
            setStatus(activeTranslate('stRerecordTranscriptBackfilled'))
          }
        } catch { setStatus(activeTranslate('stRerecordAsrBackfillFailed')) }
      } else if (selectedModel.id !== 'none') {
        setStatus(activeTranslate('stRerecordAsrLanguageUnsupported').replace('{model}', String(selectedModel.name)).replace('{language}', String(languageName(settings.sourceLanguage))))
      }
    } catch (error) { setStatus(error instanceof Error ? activeTranslate('stSegmentRerecordFailed').replace('{error}', String(error.message)) : activeTranslate('stSegmentRerecordFailedShort')) }
  }

const startSegmentRerecord = async (entry: SavedSession, segment: TranscriptEvent): Promise<void> => {
    if (captureState !== 'idle' || segmentRerecordRef.current) { setStatus(activeTranslate('stStopCaptureOrRerecordFirst')); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: settings.denoiseEnabled, autoGainControl: true }
      })
      const context = new AudioContext(); const source = context.createMediaStreamSource(stream); const processor = context.createScriptProcessor(4096, 1, 1); const sink = context.createGain(); sink.gain.value = 0
      const chunks: Float32Array[] = []
      processor.onaudioprocess = (event) => chunks.push(event.inputBuffer.getChannelData(0).slice())
      source.connect(processor); processor.connect(sink); sink.connect(context.destination)
      segmentRerecordRef.current = { entry, segment, stream, context, source, processor, sink, chunks }
      setSegmentRerecordingId(segment.id); setStatus(activeTranslate('stRerecordInProgress').replace('{time}', String(timestamp(segment.startMs))))
    } catch (error) { setStatus(error instanceof Error ? activeTranslate('stRerecordMicOpenFailed').replace('{error}', String(error.message)) : activeTranslate('stRerecordMicOpenFailedShort')) }
  }

const stopSegmentRerecord = async (): Promise<void> => {
    const active = segmentRerecordRef.current
    if (!active) return
    segmentRerecordRef.current = null; setSegmentRerecordingId(null)
    active.processor.disconnect(); active.source.disconnect(); active.sink.disconnect(); active.stream.getTracks().forEach((track) => track.stop())
    if (active.context.state !== 'closed') await active.context.close().catch(() => undefined)
    if (!active.chunks.length) { setStatus(activeTranslate('stNoRerecordAudio')); return }
    await replaceSessionSegmentAudio(active.entry, active.segment, makeWav(active.chunks, active.context.sampleRate))
  }

/** Expands the inline player for one record; pressing it again collapses it.
 *  History never auto-plays, so a list stays silent until the user asks. */
const playSession = async (entry: SavedSession): Promise<void> => {
    if (playingSessionId === entry.id) {
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      playbackUrlRef.current = null
      setPlayingSessionId(null)
      setPlaybackUrl(null)
      setStatus(activeTranslate('stPlayerCollapsed'))
      return
    }
    try {
      const audio = await loadSessionAudio(entry)
      if (!audio) {
        setStatus(activeTranslate('stLocalAudioMissingForRecord'))
        return
      }
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      const url = URL.createObjectURL(audio)
      playbackUrlRef.current = url
      setPlaybackUrl(url)
      setPlayingSessionId(entry.id)
      setStatus(activeTranslate('stPlayerExpanded').replace('{title}', String(entry.title)))
    } catch {
      setStatus(activeTranslate('stRecordAudioUnreadable'))
    }
  }

// Both download helpers throw so the format picker can show what failed;
// a successful export reports itself through the status line.
const exportSavedTranscript = async (entry: SavedSession, format: TranscriptDownloadFormat): Promise<void> => {
    const blob = await transcriptBlob(entry.segments ?? [], entry.title, format, entry.transcript)
    if (!blob) throw new Error(activeTranslate('stNoTimelineForFormat'))
    downloadTranscriptBlob(blob, entry.title, format)
    setStatus(activeTranslate('stTranscriptExported').replace('{format}', String(format.toUpperCase())))
  }

const downloadSessionAudio = async (entry: SavedSession, format: AudioDownloadFormat = 'wav'): Promise<void> => {
    const audio = await loadSessionAudio(entry)
    if (!audio) throw new Error(activeTranslate('stLocalAudioNotFound'))
    if (format === 'wav') {
      browserDownload(audio, `${entry.title}.wav`)
      setStatus(activeTranslate('stWavRecordingDownloaded'))
      return
    }
    setStatus(activeTranslate('stConvertingM4a'))
    const m4a = await encodeM4a(audio)
    browserDownload(m4a, `${entry.title}.m4a`)
    setStatus(activeTranslate('stM4aRecordingDownloaded'))
  }

const diarizeSession = async (entry: SavedSession): Promise<void> => {
    if (window.s2t && (!settings.diarizationEndpoint.trim() || !settings.diarizationModel.trim())) {
      setStatus(activeTranslate('stDiarizationEndpointRequired'))
      return
    }
    try {
      const audio = await (await loadSessionAudio(entry))?.arrayBuffer()
      if (!audio) throw new Error(activeTranslate('stLocalWavRecordingNotFound'))
      setStatus(activeTranslate('stIdentifyingSpeakers'))
      const payload = window.s2t
        ? await window.s2t.diarizeAudio({ endpoint: settings.diarizationEndpoint, model: settings.diarizationModel, audio })
        : await readJsonResponse<unknown>(await authFetch('/api/diarizations', { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-s2t-diarization-model': settings.diarizationProfiles?.some(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint) ? settings.diarizationModel : '', ...(settings.diarizationEndpoint.trim() && settings.diarizationEndpoint !== '/api/diarizations' ? { 'x-s2t-model-id': 'managed-diarization' } : {}) }, body: audio }), activeTranslate('stLocalSherpaService'))
      const turns = parseSpeakerTurns(payload)
      if (!turns.length) throw new Error(activeTranslate('stDiarizationNoSpeakerSegments'))
      setSessions((current) => current.map((currentEntry) => {
        if (currentEntry.id !== entry.id) return currentEntry
        const segments = assignSpeakersByOverlap(currentEntry.segments, turns)
        const transcript = makeTranscriptText(segments)
        const audioVersions = currentEntry.audioVersions?.map((version) => version.id === currentEntry.activeAudioVersionId ? { ...version, segments, transcript } : version)
        return { ...currentEntry, title: automaticSessionTitle(transcript, currentEntry.createdAt), segments, transcript, ...(audioVersions ? { audioVersions } : {}) }
      }))
      setStatus(activeTranslate('stCaptionsBackfilledByTurns').replace('{count}', String(turns.length)))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : activeTranslate('stSpeakerIdentificationFailed'))
    }
  }

const deleteSession = async (entry: SavedSession): Promise<void> => {
    // Deleting is the one action that must never be gated on processing state:
    // it is how a user escapes a record stuck in `running`, so blocking it here
    // would turn a background hiccup into data they cannot get rid of.
    if (qualityCorrectionActiveRef.current.has(entry.id)) { setStatus(activeTranslate('stRecordStillProcessingInBackground')); return }
    try {
      if (!window.s2t && entry.diarizationJobId) {
        const response = await authFetch(`/api/data/diarization-jobs?id=${encodeURIComponent(entry.diarizationJobId)}`, { method: 'DELETE' })
        if (!response.ok) throw new Error(activeTranslate('stCancelSpeakerJobFailed'))
      }
      const localPaths = window.s2t ? audioVersionsFor(entry).flatMap((version) => version.nativeAudioPath ? [version.nativeAudioPath] : []) : []
      const removals = await Promise.allSettled(localPaths.map((audioPath) => window.s2t!.deleteLocalAudio(audioPath)))
      const failed = removals.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      // The gateway compares session snapshots and removes every unreferenced
      // remote version through its durable compensation queue. Deleting only
      // the original key here leaves continuation/re-record versions orphaned.
      setSessions((current) => current.filter((item) => item.id !== entry.id))
      setQualityCorrectionProgress((current) => {
        const next = { ...current }; delete next[entry.id]; return next
      })
      if (playingSessionId === entry.id) { if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current); setPlayingSessionId(null); setPlaybackUrl(null) }
      setStatus(entry.savedToDisk ? activeTranslate('stLocalRecordRemovedOnly') : activeTranslate('stLocalRecordAndAudioDeleted'))
    } catch (error) { setStatus(error instanceof Error ? error.message : activeTranslate('stRecordDeleteFailed')) }
  }

const saveSessionToDisk = async (entry: SavedSession): Promise<void> => {
    try {
      const audio = entry.nativeAudioPath && window.s2t ? undefined : await loadSessionAudio(entry)
      if (!window.s2t) {
        if (!audio) throw new Error(activeTranslate('stLocalAudioNotFound'))
        browserDownload(audio, `${entry.title}.wav`)
        browserDownload(new Blob([JSON.stringify({ ...entry, audioKey: undefined, nativeAudioPath: undefined }, null, 2)], { type: 'application/json' }), `${entry.title}.json`)
        setStatus(activeTranslate('stRecordingAndTranscriptDownloaded')); return
      }
      const result = window.s2t
        ? await window.s2t.saveSession({ name: entry.title, recordingPath: entry.nativeAudioPath, audio: audio ? await audio.arrayBuffer() : undefined, transcript: entry.transcript, createdAt: entry.createdAt, durationMs: entry.durationMs, source: entry.source, segments: entry.segments, summary: entry.summary })
        : undefined
      if (result?.canceled) return
      setSessions((current) => current.map((currentEntry) => currentEntry.id === entry.id ? { ...currentEntry, nativeAudioPath: result?.audioPath ?? currentEntry.nativeAudioPath, savedToDisk: true, audioUnavailable: false } : currentEntry))
      setStatus(result?.audioPath ? activeTranslate('stSessionSavedToPath').replace('{path}', String(result.audioPath)) : activeTranslate('stSessionSaved'))
    } catch (error) { setStatus(error instanceof Error ? error.message : activeTranslate('stSaveSessionToDiskFailed')) }
  }

const openSavedSession = async (): Promise<void> => {
    if (!window.s2t) return
    try {
      const result = await window.s2t.openSession()
      if (result.canceled || !result.session) return
      const loaded: SavedSession = { ...result.session, segments: result.session.segments as TranscriptEvent[] }
      setSessions((current) => [loaded, ...current.filter((entry) => entry.nativeAudioPath !== loaded.nativeAudioPath)])
      setStatus(activeTranslate('stSessionOpened').replace('{title}', String(loaded.title)))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : activeTranslate('stSessionOpenFailed'))
    }
  }

const saveModelApiKey = async (profileId: string, key: string): Promise<void> => {
    if (!key.trim()) throw new Error(activeTranslate('stPasteApiKeyFirst'))
    if (window.s2t) { await window.s2t.saveModelApiKey(profileId, key.trim()); return }
    const response = await authFetch(`/api/data/model-credentials/${encodeURIComponent(profileId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: key.trim() }) })
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `HTTP ${response.status}`) }
    void refreshModelHealth()
  }

const validateVoiceprintSample = async (audio: Blob): Promise<void> => {
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(await audio.arrayBuffer())
      if (decoded.duration < 3) throw new Error(activeTranslate('stVoiceprintTooShort'))
      if (decoded.duration > 90) throw new Error(activeTranslate('stVoiceprintTooLong'))
      const samples = decoded.getChannelData(0)
      const stride = Math.max(1, Math.floor(samples.length / 48_000))
      let sum = 0; let count = 0
      for (let index = 0; index < samples.length; index += stride) { sum += samples[index] ** 2; count += 1 }
      if (!count || Math.sqrt(sum / count) < 0.003) throw new Error(activeTranslate('stVoiceprintTooQuiet'))
    } catch (error) { throw error instanceof Error ? error : new Error(activeTranslate('stVoiceprintWavUnreadable')) } finally { await context.close().catch(() => undefined) }
  }

const enrollVoiceprint = async (): Promise<void> => {
    if (!voiceprintFile) { setStatus(activeTranslate('stVoiceprintFileRequired')); return }
    if (!voiceprintFile.name.toLowerCase().endsWith('.wav')) { setStatus(activeTranslate('stVoiceprintPcm16Only')); return }
    if (voiceprintSharingScope !== 'private' && !voiceprintSharingConsent) { setStatus(activeTranslate('stVoiceprintConsentRequired')); return }
    try {
      await validateVoiceprintSample(voiceprintFile)
      setStatus(activeTranslate('stCreatingVoiceprint'))
      const sharingScope = voiceprintSharingScope !== 'private' && voiceprintSharingConsent ? voiceprintSharingScope || 'private' : 'private'
      const voiceprint = await voiceprintStorage.enroll(voiceprintFile, sharingScope, voiceprintSharingConsent)
      setVoiceprints((current) => [...current, voiceprint])
      setVoiceprintFile(null)
      setStatus(activeTranslate('stVoiceprintRegisteredFor').replace('{name}', String(voiceprint.NT)))
    } catch (error) { setStatus(error instanceof Error ? error.message : activeTranslate('stVoiceprintRegisterFailed')) }
  }

const deleteVoiceprint = async (id: string): Promise<void> => {
    try {
      await voiceprintStorage.remove(id)
      setVoiceprints((current) => current.filter((voiceprint) => voiceprint.id !== id))
      setStatus(activeTranslate('stVoiceprintDeleted'))
    } catch (error) { setStatus(error instanceof Error ? error.message : activeTranslate('stVoiceprintDeleteFailed')) }
  }

const cleanUpVoiceprintCapture = async (): Promise<void> => {
    voiceprintProcessorRef.current?.disconnect(); voiceprintSourceRef.current?.disconnect(); voiceprintSinkRef.current?.disconnect()
    voiceprintStreamRef.current?.getTracks().forEach((track) => track.stop())
    const context = voiceprintContextRef.current
    voiceprintProcessorRef.current = null; voiceprintSourceRef.current = null; voiceprintSinkRef.current = null; voiceprintStreamRef.current = null; voiceprintContextRef.current = null
    if (context && context.state !== 'closed') await context.close().catch(() => undefined)
  }

const startVoiceprintCapture = async (): Promise<void> => {
    if (captureState !== 'idle') { setStatus(activeTranslate('stStopCaptureBeforeVoiceprint')); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: settings.denoiseEnabled, autoGainControl: true }
      })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const sink = context.createGain(); sink.gain.value = 0
      voiceprintChunksRef.current = []
      processor.onaudioprocess = (event) => { const samples = event.inputBuffer.getChannelData(0); voiceprintChunksRef.current.push(samples.slice()); const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length); setVoiceprintLevel(dbfs(rms)) }
      source.connect(processor); processor.connect(sink); sink.connect(context.destination)
      voiceprintStreamRef.current = stream; voiceprintContextRef.current = context; voiceprintSourceRef.current = source; voiceprintProcessorRef.current = processor; voiceprintSinkRef.current = sink
      setVoiceprintCaptureState('recording')
      setStatus(activeTranslate('stRecordingVoiceprintHint'))
    } catch (error) { await cleanUpVoiceprintCapture(); setStatus(error instanceof Error ? activeTranslate('stVoiceprintMicOpenFailed').replace('{error}', String(error.message)) : activeTranslate('stVoiceprintMicOpenFailedShort')) }
  }

const stopVoiceprintCapture = async (): Promise<void> => {
    const context = voiceprintContextRef.current
    const chunks = voiceprintChunksRef.current
    if (!context || !chunks.length) { await cleanUpVoiceprintCapture(); setVoiceprintCaptureState('idle'); setStatus(activeTranslate('stNoVoiceprintAudio')); return }
    const wav = makeWav(chunks, context.sampleRate)
    await cleanUpVoiceprintCapture(); voiceprintChunksRef.current = []
    setVoiceprintFile(new File([wav], `voiceprint-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`, { type: 'audio/wav' }))
    setVoiceprintCaptureState('idle')
    setVoiceprintLevel(-60)
    setStatus(activeTranslate('stVoiceprintSampleRecorded'))
  }

const summaryPort = useMemo(() => createSummaryPort({ endpoint: settings.summaryEndpoint, model: settings.summaryModel, requiresApiKey: settings.summaryRequiresApiKey }), [settings.summaryEndpoint, settings.summaryModel, settings.summaryRequiresApiKey, userId])
const completeSummary = (messages: Array<{ role: 'system' | 'user'; content: string }>, singleAttempt = false, onText?: (text: string) => void, signal?: AbortSignal): Promise<{ text: string }> =>
  summaryPort.complete({ messages, singleAttempt, onText, signal })

const summaryInstruction = (targetLanguage?: string): string => prompt('summary', { language: languageName(targetLanguage ?? resolveUiLanguage('system')), template: settings.summaryTemplate })

const summarizeTranscript = (transcript: string, onText?: (text: string) => void, signal?: AbortSignal): Promise<string> => summarizeTranscriptWorkflow(transcript, { completeSummary, summaryInstruction, compressionFailure: () => new Error(activeTranslate('stSummaryCompressionFailed')) }, onText, signal)

const generateSessionTitle = async (sessionId: string, transcript: string): Promise<void> => {
    if (!settings.summaryEndpoint.trim() || !settings.summaryModel.trim() || !transcript.trim() || titleActiveRef.current.has(sessionId)) return
    titleActiveRef.current.add(sessionId)
    setTitleGeneratingIds(current => [...current, sessionId])
    const language = ({ 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', en: 'English', ja: '日本語', de: 'Deutsch' } as const)[resolveUiLanguage(settings.uiLanguage)]
    try {
      const result = await completeSummary([
        { role: 'system', content: prompt('title', { language, maximum: maximumGeneratedSessionTitleLength }) },
        { role: 'user', content: transcript.slice(0, 24_000) }
      ])
      const title = result.text.replace(/[\r\n]+/g, ' ').replace(/^[-#*\s]+|[-#*\s]+$/g, '').trim()
      if (!title) return
      const visible = title.length > maximumGeneratedSessionTitleLength
        ? `${title.slice(0, maximumGeneratedSessionTitleLength - 1)}…`
        : title
      setSessions((current) => current.map((entry) => entry.id === sessionId ? { ...entry, title: visible } : entry))
    } catch { /* Keep deterministic fallback title when the LLM is unavailable. */ }
    finally {
      titleActiveRef.current.delete(sessionId)
      setTitleGeneratingIds(current => current.filter(id => id !== sessionId))
    }
  }

const regenerateSessionTitle = async (entry: SavedSession): Promise<void> => {
  if (titleActiveRef.current.has(entry.id)) return
  const transcript = entry.transcript?.trim() || makeTranscriptText(entry.segments)
  if (!transcript.trim()) { setStatus(activeTranslate('titleTranscriptRequired')); return }
  if (!settings.summaryEndpoint.trim() || !settings.summaryModel.trim()) { setStatus(activeTranslate('titleModelRequired')); return }
  titleActiveRef.current.add(entry.id)
  setTitleGeneratingIds(current => [...current, entry.id])
  try {
    const result = await completeSummary([
      { role: 'system', content: prompt('title', { language: languageName(resolveUiLanguage(settings.uiLanguage)), maximum: maximumGeneratedSessionTitleLength }) },
      { role: 'user', content: transcript.slice(0, 24_000) }
    ], true)
    const title = result.text.replace(/[\r\n]+/g, ' ').replace(/^[-#*\s]+|[-#*\s]+$/g, '').trim()
    if (!title) throw new Error(activeTranslate('stSummaryServiceEmpty'))
    const visible = title.length > maximumGeneratedSessionTitleLength ? `${title.slice(0, maximumGeneratedSessionTitleLength - 1)}…` : title
    setSessions(current => current.map(item => item.id === entry.id && item.title === entry.title && (item.transcript?.trim() || makeTranscriptText(item.segments)) === transcript ? { ...item, title: visible } : item))
  } catch (error) {
    setStatus(activeTranslate('titleGenerationFailed').replace('{error}', error instanceof Error ? error.message : String(error)))
  } finally {
    titleActiveRef.current.delete(entry.id)
    setTitleGeneratingIds(current => current.filter(id => id !== entry.id))
  }
}

const cancelSessionSummary = (sessionId: string): void => {
    const request = summaryRequestsRef.current.get(sessionId)
    if (!request) return
    request.controller.abort()
    summaryRequestsRef.current.delete(sessionId)
    summaryGenerationRef.current.set(sessionId, request.generation + 1)
    setSummaryGeneratingIds(current => current.filter(id => id !== sessionId))
    setSessions(current => current.map(entry => {
      if (entry.id !== sessionId) return entry
      const currentTranscript = entry.transcript.trim() || makeTranscriptText(entry.segments)
      const sameSource = transcriptSignature(currentTranscript) === request.transcriptSignature && (entry.activeAudioVersionId ?? audioVersionsFor(entry)[0]?.id) === request.sourceVersionId
      // The rollback belongs here too: the aborted promise settles later, and a
      // source that changed while generating must not keep the preview either.
      const reverted = revertSummaryPreview(entry, request)
      return sameSource ? { ...reverted, ...request.previous } : { ...reverted, summaryState: undefined }
    }))
  }

const createSessionSummary = async (sessionId: string, transcript: string, targetLanguage?: string): Promise<boolean> => {
    if (!settings.summaryEndpoint.trim() || !settings.summaryModel.trim() || !transcript.trim() || summaryRequestsRef.current.has(sessionId)) return false
    const previousEntry = sessions.find(entry => entry.id === sessionId)
    if (!previousEntry) return false
    const generation = (summaryGenerationRef.current.get(sessionId) ?? 0) + 1
    const request: SummaryRequest = {
      generation, controller: new AbortController(), owner: requestEpoch(), userId, transcriptSignature: transcriptSignature(transcript), sourceVersionId: previousEntry.activeAudioVersionId ?? audioVersionsFor(previousEntry)[0]?.id,
      previous: { summary: previousEntry.summary, summaryState: previousEntry.summaryState, summaryError: previousEntry.summaryError, summarySourceSignature: previousEntry.summarySourceSignature, summarySourceVersionId: previousEntry.summarySourceVersionId, summaryTranslation: previousEntry.summaryTranslation, summaryTranslationTargetLanguage: previousEntry.summaryTranslationTargetLanguage }
    }
    summaryGenerationRef.current.set(sessionId, generation)
    summaryRequestsRef.current.set(sessionId, request)
    setSummaryGeneratingIds(current => current.includes(sessionId) ? current : [...current, sessionId])
    const sourceVersionId = request.sourceVersionId
    const ownsRequest = (): boolean => summaryRequestsRef.current.get(sessionId) === request && requestEpoch() === request.owner
    const sourceStillCurrent = (): boolean => {
      const entry = sessionsRef.current.find(item => item.id === sessionId)
      if (!entry) return false
      const currentTranscript = entry.transcript.trim() || makeTranscriptText(entry.segments)
      return transcriptSignature(currentTranscript) === request.transcriptSignature && (entry.activeAudioVersionId ?? audioVersionsFor(entry)[0]?.id) === request.sourceVersionId
    }
    setSessions(current => current.map(entry => entry.id !== sessionId ? entry : {
      ...entry,
      ...(!entry.transcript.trim() ? { transcript, audioVersions: entry.audioVersions?.map(version => version.id === sourceVersionId ? { ...version, transcript } : version) } : {}),
      summaryState: 'generating', summaryError: undefined
    }))
    try {
      let previewed = false
      const text = await (targetLanguage ? summarizeTranscriptWorkflow(transcript, { completeSummary, summaryInstruction: () => summaryInstruction(targetLanguage), compressionFailure: () => new Error(activeTranslate('stSummaryCompressionFailed')) }, undefined, request.controller.signal) : summarizeTranscript(transcript, partial => {
        // Keep streaming previews, but only the owning request may replace the
        // display. cancelSessionSummary restores the captured summary/translation.
        if (ownsRequest() && sourceStillCurrent()) {
          if (!previewed) { previewed = true; summaryTranslationRef.current.delete(sessionId) }
          request.preview = partial
          setSessions(current => current.map(entry => entry.id === sessionId ? {
            ...entry, summary: partial, summarySourceSignature: undefined, summarySourceVersionId: undefined,
            summaryTranslation: undefined, summaryTranslationTargetLanguage: undefined
          } : entry))
        }
      }, request.controller.signal))
      if (!ownsRequest() || !sourceStillCurrent()) { rollbackSummaryPreview(sessionId, request); return false }
      if (!text) throw new Error(activeTranslate('stSummaryServiceEmpty'))
      // Invalidate a previous translation only after a new source summary won.
      summaryTranslationRef.current.delete(sessionId)
      setSessions(current => current.map(entry => entry.id === sessionId && transcriptSignature(entry.transcript.trim() || makeTranscriptText(entry.segments)) === request.transcriptSignature && (entry.activeAudioVersionId ?? audioVersionsFor(entry)[0]?.id) === request.sourceVersionId ? {
        ...entry, summaryState: undefined, summaryError: undefined,
        ...(targetLanguage ? { summaryTranslation: text, summaryTranslationTargetLanguage: targetLanguage } : { summary: text, summarySourceSignature: transcriptSignature(transcript), summarySourceVersionId: sourceVersionId, summaryTranslation: undefined, summaryTranslationTargetLanguage: undefined })
      } : entry))
      return true
    } catch (error) {
      if (!ownsRequest()) { rollbackSummaryPreview(sessionId, request); return false }
      const message = error instanceof Error ? activeTranslate('stSummaryGenerationFailed').replace('{error}', error.message) : activeTranslate('stSummaryGenerationFailedShort')
      setSessions(current => current.map(entry => {
        if (entry.id !== sessionId) return entry
        const currentTranscript = entry.transcript.trim() || makeTranscriptText(entry.segments)
        const sameSource = transcriptSignature(currentTranscript) === request.transcriptSignature && (entry.activeAudioVersionId ?? audioVersionsFor(entry)[0]?.id) === request.sourceVersionId
        const reverted = revertSummaryPreview(entry, request)
        return sameSource ? { ...reverted, ...request.previous, summaryError: message } : { ...reverted, summaryState: undefined }
      }))
      setStatus(message)
      return false
    } finally {
      if (summaryRequestsRef.current.get(sessionId) === request) {
        summaryRequestsRef.current.delete(sessionId)
        setSummaryGeneratingIds(current => current.filter(id => id !== sessionId))
        setSessions(current => current.map(entry => entry.id === sessionId && entry.summaryState === 'generating' ? { ...entry, summaryState: undefined } : entry))
      }
    }
  }

const summaryTranslationRef = useRef(new Map<string, string>())

/** Translate an already-generated summary into the configured target language.
 *  The result is stored beside the summary and is replaced only when the
 *  summary itself is regenerated (the field is cleared on every rewrite).
 *  A newer call supersedes an in-flight one for the same session. */
const translateSummary = (entry: SavedSession, targetOverride?: string, signal?: AbortSignal): Promise<void> => {
  const sourceLanguage = ({ 'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', en: 'en-US', ja: 'ja-JP', de: 'de-DE' } as const)[resolveUiLanguage('system')]
  return translateSessionSummary(entry, { sourceLanguage, targetLanguage: targetOverride ?? resolveTranslationTarget(sourceLanguage, settings.targetLanguage), glossary: settings.glossary, signal }, {
    generations: summaryTranslationRef.current, complete: textCompletionPort.complete,
    emptyError: () => new Error(activeTranslate('stTranslationServiceEmpty')),
    publish: (source, text, translated, targetLanguage) => setSessions(current => current.map(item => item.id === source.id && item.summary?.trim() === text ? { ...item, summaryTranslation: translated, summaryTranslationTargetLanguage: targetLanguage } : item))
  })
}

const createSummary = async (): Promise<void> => {
    const transcript = makeTranscriptText(transcripts.filter((entry) => entry.status === 'final'))
    if (!settings.summaryEndpoint.trim() || !settings.summaryModel.trim() || !transcript) {
      setSummaryStatus(activeTranslate('stSummaryApiAndTranscriptRequired'))
      return
    }
    setSummaryStatus(activeTranslate('stGeneratingMeetingNotes'))
    try {
      const text = await summarizeTranscript(transcript, setSummaryText)
      setSummaryText(text)
      setSummaryStatus(text ? activeTranslate('stMeetingNotesGenerated') : activeTranslate('stSummaryServiceEmpty'))
    } catch (error) { setSummaryStatus(error instanceof Error ? error.message : activeTranslate('stSummaryCreationFailed')) }
  }

const summarizeSession = async (entry: SavedSession, targetLanguage?: string): Promise<void> => {
    if (entry.processingState === 'running' || qualityCorrectionActiveRef.current.has(entry.id)) { setStatus(activeTranslate('stRecordStillProcessingInBackground')); return }
    const transcript = entry.transcript.trim() || makeTranscriptText(entry.segments)
    if (!transcript.trim()) { setStatus(activeTranslate('stNoTranscriptToSummarize')); return }
    if (!settings.summaryEndpoint.trim() || !settings.summaryModel.trim()) { setStatus(activeTranslate('stSummaryApiAndModelRequired')); return }
    if (await createSessionSummary(entry.id, transcript, targetLanguage)) setStatus(activeTranslate('stMeetingSummaryUpdated'))
  }

const canRecord = captureState === 'idle'

const { filteredSessions, historyPageCount, currentHistoryPage, pagedSessions } = useMemo(() => sessionHistory(sessions, {
  search: historySearch, sort: historySort, direction: historySortDirection, page: historyPage,
  pageSize: historyPageSize, locale: resolveUiLanguage(settings.uiLanguage)
}), [sessions, historySearch, historySort, historySortDirection, historyPage, historyPageSize, settings.uiLanguage])

const viewingSession = sessions.find((entry) => entry.id === viewingSessionId) ?? null

const visibleTranscripts = useMemo(() => transcripts.filter(entry => entry.status !== 'gap' && entry.startMs >= clearedThroughMs), [transcripts, clearedThroughMs])
const captionSearch = useMemo(() => createTextSearch(transcriptSearch), [transcriptSearch])
// Group before matching, and search the complete visible timeline when active.
const searchedLiveCaptionGroups = useMemo(() => searchCaptionGroups(renderedLiveCaptionWindow(visibleTranscripts, captionSearch.active), captionSearch), [visibleTranscripts, captionSearch])

const clearCaptions = async (): Promise<void> => {
    if (captureState === 'starting' || captureState === 'saving') return
    // Finish the current recording before releasing its session identity.
    // stopCapture drains ASR/translation and preserves the recording in history.
    // A failed stop is reported after the reset below; the caller swallows the
    // promise (`void clearCaptions()`), so it must never reject unhandled.
    let stopError: unknown
    try {
      if (captureState === 'recording' || captureState === 'paused') await stopCapture()
    } catch (error) { stopError = error }
    // The identity reset runs even when stopping fails: a surviving session
    // id is what kept offering 接續收音 after the screen was cleared.
    liveSessionIdRef.current = null
    continuationTargetRef.current = null
    continuationEventIdsRef.current.clear()
    savedLiveSnapshotRef.current = null
    try {
      translationQueueRef.current?.reset()
      if (translationQueueRef.current) translationQueueRef.current.paused = false
      unsubscribeModelRef.current?.()
      unsubscribeModelErrorRef.current?.()
    } catch (error) { console.error('s2t.clear.cleanup', error) }
    transcriptsRef.current = []
    setTranscripts([])
    sampleOffsetRef.current = 0
    clearBoundaryRef.current = -1
    setClearedThroughMs(-1)
    setElapsedMs(0); setCaptionTimerOffsetMs(0)
    setSummaryText(''); setSummaryStatus('')
    setEditingTranscriptId(null); setTranscriptSearch(''); setFollowingCaptions(true)
    // Re-initialise the workspace itself, not just the caption list.
    setCaptureState('idle')
    setStatus(stopError instanceof Error ? stopError.message : stopError ? String(stopError) : activeTranslate('stReady'))
    setViewingSessionId(null)
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
    playbackUrlRef.current = null
    setPlaybackUrl(null); setPlayingSessionId(null)
    setImportError(''); setImportProgress(null)
    setView('live')
  }

const saveLiveCaptionsBeforeSwitch = async (): Promise<void> => {
    const segments = transcriptsRef.current.filter((item) => item.status !== 'partial')
    if (!segments.length) return
    const transcript = makeTranscriptText(segments)
    const currentId = liveSessionIdRef.current
    const existing = currentId ? sessions.find((item) => item.id === currentId) : undefined
    // The history record owns final speaker results. Do not save an unchanged
    // live preview over its newer background snapshot when switching records.
    if (existing && (existing.processingState === 'running' || savedLiveSnapshotRef.current === transcriptsRef.current)) return
    const hasChanged = existing && JSON.stringify(existing.segments) !== JSON.stringify(segments)
    const sessionId = existing?.id ?? crypto.randomUUID()
    const transcriptChanged = existing ? transcriptSignature(existing.transcript) !== transcriptSignature(transcript) : true
    const nextEntry: SavedSession = existing
      ? {
          ...existing,
          transcript,
          segments,
          audioVersions: existing.audioVersions?.map((version) => version.id === existing.activeAudioVersionId
            ? { ...version, segments, transcript }
            : version),
          ...(transcriptChanged ? { summary: undefined, summaryState: undefined, summarySourceSignature: undefined, summarySourceVersionId: undefined, summaryTranslation: undefined, summaryTranslationTargetLanguage: undefined } : {})
        }
      : {
          id: sessionId,
          title: automaticSessionTitle(transcript),
          createdAt: new Date().toISOString(),
          durationMs: Math.max(0, ...segments.map((item) => item.endMs)),
          source: activeTranslate('floatingCaptions'),
          transcript,
          audioKey: `transcript-${sessionId}`,
          audioUnavailable: true,
          segments
        }
    if (existing && !hasChanged) return
    const nextSessions = existing
      ? sessions.map((item) => item.id === existing.id ? nextEntry : item)
      : [nextEntry, ...sessions]
    setSessions(nextSessions)
    liveSessionIdRef.current = nextEntry.id
  }

const loadSessionIntoLive = async (entry: SavedSession): Promise<boolean> => {
    if (entry.processingState === 'running' || qualityCorrectionActiveRef.current.has(entry.id)) { setStatus(activeTranslate('stRecordStillProcessingInBackground')); return false }
    if (captureState !== 'idle') { setStatus(activeTranslate('stStopCaptureBeforeHistoryLoad')); return false }
    try { await saveLiveCaptionsBeforeSwitch() }
    catch (error) { setStatus(error instanceof Error ? activeTranslate('stLiveCaptionsSaveFailed').replace('{error}', String(error.message)) : activeTranslate('stLiveCaptionsSaveFailedShort')); return false }
    translationQueueRef.current!.reset()
    translationQueueRef.current!.paused = false
    setTranscripts(entry.segments)
    setElapsedMs(entry.durationMs); setCaptionTimerOffsetMs(0)
    liveSessionIdRef.current = entry.id
    setClearedThroughMs(0); clearBoundaryRef.current = 0
    setEditingTranscriptId(null); setTranscriptSearch(''); setFollowingCaptions(true)
    setViewingSessionId(null); setStatus(activeTranslate('stLoadedIntoLiveCaptions').replace('{title}', String(entry.title)))
    return true
  }

const prepareSessionContinuation = async (entry: SavedSession): Promise<boolean> => {
    if (captureState !== 'idle' || preparingContinuationRef.current) return false
    preparingContinuationRef.current = true
    setPreparingContinuation(true)
    setView('live')
    try {
      if (!await loadSessionIntoLive(entry)) return false
      const audio = await loadSessionAudio(entry)
      if (!audio) throw new Error(activeTranslate('stSelectedAudioVersionNotFound'))
      const baseDurationMs = await audioDurationMs(audio, entry.durationMs)
      continuationTargetRef.current = { entry, audio, baseDurationMs }
      setElapsedMs(baseDurationMs)
      return true
    } catch (error) {
      continuationTargetRef.current = null
      setStatus(error instanceof Error ? activeTranslate('stContinueRecordingFailedDetail').replace('{error}', String(error.message)) : activeTranslate('stContinueRecordingFailed'))
      return false
    } finally { preparingContinuationRef.current = false; setPreparingContinuation(false) }
  }

const renameSession = (id: string): void => {
    if (sessionMutationBlocked(id)) { setRenamingSessionId(null); return }
    const title = titleDraft.trim().slice(0, 200)
    if (!title) { setRenamingSessionId(null); return }
    setSessions((current) => current.map((entry) => entry.id === id ? { ...entry, title } : entry))
    setRenamingSessionId(null)
  }

const visibleSessionStorageStates = useMemo(() => !window.s2t && sessionsHydrated
  ? sessionStorageStatesForSnapshot(sessions, sessionSyncRef.current?.getState().baseline ?? [], sessionStorageStates)
  : sessionStorageStates, [sessions, sessionsHydrated, sessionStorageStates])

return {
isFloatingCaptionWindow,
devices,
selectedDeviceId,
includeSystemAudio,
captureState,
microphoneLevel,
systemLevel,
elapsedMs,
captionDisplayElapsedMs: Math.max(0, elapsedMs - captionTimerOffsetMs),
setTranscripts,
followingCaptions,
setFollowingCaptions,
setViewingSessionId,
viewingSessionId,
renamingSessionId,
setRenamingSessionId,
titleDraft,
setTitleDraft,
status,
setStatus,
view,
setView,
sessions,
qualityCorrectionProgress,
settings,
setSettings,
importedFile,
importError,
importProgress,
settingsSaved,
environmentModelsHydrated,
productTitleImage,
denoiseApplied,
browserRecordingStorage,
remoteSessionSyncState,
remoteSessionConflicts,
resolveSessionConflict,
storageHealth,
audioMigrationStatus,
storageCompensations,
storageOrphanAudio,
floatingCaptionText,
floatingCaptionFullscreen,
webCaptionPopup,
webCaptionWindow,
webCaptionPortalRoot,
webCaptionIsPip,
webCaptionFullscreen,
webCaptionFullscreenError,
captionScale,
setCaptionScale,
playingSessionId,
playbackUrl,
newModelName,
setNewModelName,
newModelEndpoint,
setNewModelEndpoint,
newModelId,
setNewModelId,
newModelApiKey,
newModelRequiresApiKey,
setNewModelRequiresApiKey,
setNewModelApiKey,
newModelUsesBuiltin,
setNewModelUsesBuiltin,
apiKeyDraft,
setApiKeyDraft,
apiKeyStatus,
translationKeyDraft,
setTranslationKeyDraft,
summaryKeyDraft,
setSummaryKeyDraft,
diarizationKeyDraft,
setDiarizationKeyDraft,
voiceprintFile,
setVoiceprintFile,
voiceprintSharingScope,
setVoiceprintSharingScope,
voiceprintSharingConsent,
setVoiceprintSharingConsent,
voiceprints,
voiceprintCaptureState,
voiceprintLevel,
transcriptSearch,
setTranscriptSearch,
editingTranscriptId,
setEditingTranscriptId,
drawer,
setDrawer,
historyPageSize,
setHistoryPageSize,
setHistoryPage,
historySort,
setHistorySort,
historySortDirection,
setHistorySortDirection,
historySearch,
setHistorySearch,
sessionTranscriptSearch,
setSessionTranscriptSearch,
summaryText,
summaryStatus,
modelFilter,
setModelFilter,
modelHealth,
acceptModelApiTestResult,
refreshModelHealth,
sileroVadAvailable,
systemStreamRef,
microphoneMeterValueRef,
systemMeterValueRef,
transcriptContainerRef,
webCaptionPopupRef,
selectedModel,
refreshDevices,
requestTranslation,
cancelPendingTranslations,
selectDevice,
selectSystemAudio,
applyAudioSources,
startCapture,
togglePause,
stopCapture,
exportTranscript,
copyTranscript,
copySummary,
updateTranscript,
updateSpeaker,
renameLiveSpeaker,
updateSessionSpeaker,
updateSavedTranscript,
updateSavedTranscriptTiming,
updateTranscriptTiming,
saveSettings,
addModelProfile,
updateSelectedModel,
selectTranslationProfile,
saveTranslationProfile,
removeSelectedModel,
saveApiKey,
openFloatingCaptions,
closeFloatingCaptions,
toggleFloatingCaptionFullscreen,
closeWebCaptionPopup,
toggleWebCaptionFullscreen,
selectImportFile,
transcribeImportedFile,
cancelImport,
playSession,
exportSavedTranscript,
downloadSessionAudio,
continueSession,
selectAudioVersion,
replaceSessionSegmentAudio,
segmentRerecordingId,
startSegmentRerecord,
stopSegmentRerecord,
diarizeSession,
finalizeSession,
deleteSession,
saveSessionToDisk,
openSavedSession,
saveModelApiKey,
enrollVoiceprint,
deleteVoiceprint,
startVoiceprintCapture,
stopVoiceprintCapture,
createSummary,
summarizeSession,
cancelSessionSummary,
translateSummary,
canRecord,
canContinueRecording: sessions.some((entry) => entry.id === liveSessionIdRef.current),
startOrContinueRecording,
historyPageCount,
currentHistoryPage,
pagedSessions,
filteredSessions,
viewingSession,
visibleTranscripts,
searchedLiveCaptionGroups,
clearCaptions,
loadSessionIntoLive,
prepareSessionContinuation,
preparingContinuation,
renameSession,
regenerateSessionTitle,
titleGeneratingIds,
summaryGeneratingIds,
retryRemoteSessionSync,
retryFailedSession,
retryStorageCompensations,
cleanOrphanAudio,
sessionStorageStates: visibleSessionStorageStates
}
}

export type AppController = ReturnType<typeof useAppController>
