import { NavigationGlyph } from './NavigationGlyph'
import { importFileAccept } from '../../transcript/import-formats'
import { CaptionPopout } from './CaptionPopout'
import { TooltipButton } from './TooltipButton'
import { createPortal } from 'react-dom'
import { type SavedSession, type ModelCapabilities, type View } from '../../../shared/types'
import { dbfsLabel, meterPercent } from '../../../shared/services/audio'
import { groupLiveCaptions } from '../services/live-caption'
import { timestamp } from '../../../shared/services/transcript'
import { modelEndpoint, textEndpoint } from '../../../shared/services/settings'
import { responseSpeeds } from '../../capture/vad'
import { interfaceTranslate, resolveUiLanguage, setActiveUiLanguage, translate } from '../../../shared/i18n'
import { addSummaryTemplate as createSummaryTemplate, removeSelectedSummaryTemplate, selectSummaryTemplate as resolveSummaryTemplate } from '../services/summary-templates'
import { downloadSummaryBlob, summaryBlob, type SummaryDownloadFormat } from '../services/summary-document'
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownSummary } from './MarkdownSummary'
import { DownloadPicker, type DownloadPick, type DownloadScope } from './DownloadPicker'
import { SpeakerBatchRename } from './SpeakerBatchRename'
import { SummaryWorkspace } from './SummaryWorkspace'
import { SettingsView } from './settings/SettingsView'

import type { AppController } from '../hooks/useAppController'
import type { AuthUser } from '../../auth/services/auth-client'

export function AppView({ controller, user, onLogout }: { controller: AppController; user: AuthUser; onLogout: () => Promise<void> }): ReactElement {
const [modelDialogOpen, setModelDialogOpen] = useState(false)
const [modelPurpose, setModelPurpose] = useState<'asr' | 'translation' | 'summary' | 'diarization' | 'embedding'>('asr')
const [editingModelId, setEditingModelId] = useState<string | null>(null)
const [modelDialogCanDelete, setModelDialogCanDelete] = useState(false)
const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilities>({ asrMode: 'non-streaming', vadSource: 'app', timestampPrecision: 'chunk' })
const [editingSessionSegmentId, setEditingSessionSegmentId] = useState<string | null>(null)
const [modelSearch, setModelSearch] = useState('')
const [newSummaryTemplateName, setNewSummaryTemplateName] = useState('')
const [newSummaryTemplateContent, setNewSummaryTemplateContent] = useState('')
const [isCreatingSummaryTemplate, setIsCreatingSummaryTemplate] = useState(false)
const [historyCollapsed, setHistoryCollapsed] = useState(true)
const [liveControlsOpen, setLiveControlsOpen] = useState(false)
const [titleImageFailed, setTitleImageFailed] = useState(false)
const [sidebarSection, setSidebarSection] = useState<'history' | 'capture' | 'speakers'>('history')
const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
const sessionMenuRef = useRef<HTMLDivElement | null>(null)
const [processingDetailsId, setProcessingDetailsId] = useState<string | null>(null)
const [downloadPicker, setDownloadPicker] = useState<{ kind: 'session'; entry: SavedSession; scope: DownloadScope } | { kind: 'summary'; text: string; title: string } | null>(null)
const [downloadBusy, setDownloadBusy] = useState(false)
const [downloadError, setDownloadError] = useState<string | null>(null)
const [summarySessionId, setSummarySessionId] = useState<string | null>(null)
const [settingsReturnView, setSettingsReturnView] = useState<Exclude<View, 'settings'>>('live')
const [settingsDirty, setSettingsDirty] = useState(false)
const [leaveRequest, setLeaveRequest] = useState<{ target: View; nonce: number } | null>(null)
const openSettings = (from: View): void => { setSettingsReturnView(from === 'settings' ? 'live' : from); setView('settings') }
const navigate = (target: View): void => {
  if (view === 'settings' && target !== 'settings' && settingsDirty) { setLeaveRequest({ target, nonce: Date.now() }); return }
  setView(target)
}
const downloadSummary = async (text: string, format: SummaryDownloadFormat, title: string): Promise<void> => { const blob = await summaryBlob(text, title, format); if (!blob) { setStatus(ui('noExportableSummary')); return } downloadSummaryBlob(blob, title, format) }
const matchesModelSearch = (...values: string[]): boolean => { const query = modelSearch.trim().toLocaleLowerCase(); return !query || values.join(' ').toLocaleLowerCase().includes(query) }
const {
isFloatingCaptionWindow,
productTitleImage,
devices,
selectedDeviceId,
includeSystemAudio,
captureState,
microphoneLevel,
systemLevel,
captionDisplayElapsedMs,
setTranscripts,
followingCaptions,
setFollowingCaptions,
setViewingSessionId,
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
floatingCaptionText,
floatingCaptionFullscreen,
webCaptionPopup,
webCaptionWindow,
webCaptionPortalRoot,
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
setNewModelApiKey,
newModelRequiresApiKey,
setNewModelRequiresApiKey,
newModelUsesBuiltin,
setNewModelUsesBuiltin,
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
systemStreamRef,
microphoneMeterValueRef,
systemMeterValueRef,
transcriptContainerRef,
refreshDevices,
requestTranslation,
cancelPendingTranslations,
selectDevice,
selectSystemAudio,
togglePause,
stopCapture,
copySummary,
updateTranscript,
updateSpeaker,
renameLiveSpeaker,
updateSessionSpeaker,
updateSavedTranscript,
updateSavedTranscriptTiming,
updateTranscriptTiming,
addModelProfile,
selectTranslationProfile,
saveModelApiKey,
openFloatingCaptions,
closeFloatingCaptions,
toggleFloatingCaptionFullscreen,
toggleWebCaptionFullscreen,
selectImportFile,
transcribeImportedFile,
cancelImport,
playSession,
exportSavedTranscript,
downloadSessionAudio,
continueSession,
replaceSessionSegmentAudio,
segmentRerecordingId,
startSegmentRerecord,
stopSegmentRerecord,
finalizeSession,
deleteSession,
copyTranscript,
openSavedSession,
enrollVoiceprint,
deleteVoiceprint,
startVoiceprintCapture,
stopVoiceprintCapture,
summarizeSession,
translateSummary,
canRecord,
canContinueRecording,
startOrContinueRecording,
historyPageCount,
currentHistoryPage,
pagedSessions,
filteredSessions,
viewingSession,
visibleTranscripts,
renderedLiveTranscripts,
clearCaptions,
loadSessionIntoLive,
renameSession,
sessionStorageStates
} = controller

useEffect(() => { document.documentElement.lang = resolveUiLanguage(settings.uiLanguage); setActiveUiLanguage(settings.uiLanguage) }, [settings.uiLanguage])
useEffect(() => {
  const closeOnOutsidePointer = (event: PointerEvent): void => {
    if (sessionMenuRef.current && !sessionMenuRef.current.contains(event.target as Node)) setSessionMenuId(null)
  }
  const closeOnEscape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') { setSessionMenuId(null); setDownloadPicker(null) } }
  document.addEventListener('pointerdown', closeOnOutsidePointer)
  document.addEventListener('keydown', closeOnEscape)
  return () => { document.removeEventListener('pointerdown', closeOnOutsidePointer); document.removeEventListener('keydown', closeOnEscape) }
}, [])
// `setStatus` carries every one-off confirmation (copy, export, playback…), but
// nothing else in the layout renders it, so surface it as a transient toast.
const [statusToast, setStatusToast] = useState<string | null>(null)
const lastStatusRef = useRef(status)
useEffect(() => {
  if (!status || status === lastStatusRef.current) return
  lastStatusRef.current = status
  setStatusToast(status)
  const timer = window.setTimeout(() => setStatusToast((current) => (current === status ? null : current)), 4000)
  return () => window.clearTimeout(timer)
}, [status])
const t = (key: Parameters<typeof translate>[1]): string => translate(settings.uiLanguage, key)
const ui = (key: Parameters<typeof interfaceTranslate>[1]): string => interfaceTranslate(settings.uiLanguage, key)
// Every download entry point offers a format menu; exactly one file is fetched
// per pick so a click never downloads every available export at once.
const openDownloadPicker = (entry: SavedSession, scope: DownloadScope): void => {
  setSessionMenuId(null)
  setDownloadError(null)
  setDownloadBusy(false)
  setDownloadPicker({ kind: 'session', entry, scope })
}
const openSummaryDownloadPicker = (text: string, title: string): void => {
  setSessionMenuId(null)
  setDownloadError(null)
  setDownloadBusy(false)
  setDownloadPicker({ kind: 'summary', text, title })
}
const pickDownload = (pick: DownloadPick): void => {
  if (!downloadPicker || downloadBusy) return
  setDownloadBusy(true)
  setDownloadError(null)
  void (async () => {
    if (downloadPicker.kind === 'summary') {
      if (pick.kind === 'summary') await downloadSummary(downloadPicker.text, pick.format, downloadPicker.title)
      return
    }
    const entry = downloadPicker.entry
    if (pick.kind === 'audio') await downloadSessionAudio(entry, pick.format)
    else if (pick.kind === 'transcript') await exportSavedTranscript(entry, pick.format)
  })()
    .then(() => setDownloadPicker(null))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : ui('downloadPickFailed')
      setDownloadError(message)
      setStatus(message)
    })
    .finally(() => setDownloadBusy(false))
}
  const responseSpeedKey = settings.responseSpeed === 'fast' ? 'speedFast' : settings.responseSpeed === 'slow' ? 'speedSlow' : 'speedNormal'
const modelHealthBadge = (id: string): ReactElement => {
  const health = modelHealth[id]
  const state = health?.state ?? 'unknown'
  const label = state === 'healthy' ? ui('modelHealthHealthy') : state === 'degraded' ? ui('modelHealthDegraded') : state === 'unhealthy' ? ui('modelHealthFailed') : ui('modelHealthUnknown')
  return <span className={`model-health ${state}`} title={health?.reason ?? ui('modelHealthNotChecked')}><i aria-hidden="true" />{label}</span>
}

const processingBadge = (entry: SavedSession, location = 'card'): ReactElement => {
  const state = entry.processingState ?? 'completed'
  const stageKeys = { asr: 'recordProcessingAsr', translation: 'recordProcessingTranslation', saving: 'recordProcessingSaving', diarization: 'recordProcessingDiarization' } as const
  const label = ui(state === 'running' ? 'recordProcessingRunning' : state === 'failed' ? 'recordProcessingFailed' : 'recordProcessingCompleted')
  const detail = state === 'failed' ? entry.processingError
    : state === 'running' && entry.processingStage ? ui(stageKeys[entry.processingStage]) : undefined
  if (!detail) return <span className={`session-processing-state ${state}`} role="status">{label}</span>
  const detailId = `processing-detail-${location}-${entry.id}`
  const expanded = processingDetailsId === detailId
  return <span className="session-processing-disclosure">
    <button type="button" className={`session-processing-state ${state}`} aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}
      onClick={() => setProcessingDetailsId(expanded ? null : detailId)}>{label}</button>
    {expanded && <span id={detailId} className="session-processing-detail">{detail}</span>}
  </span>
}

const qualityCorrectionRunning = (entry: SavedSession): boolean => {
  const stage = qualityCorrectionProgress[entry.id]?.stage
  return stage === 'loading' || stage === 'asr' || stage === 'diarization'
}
const qualityCorrectionBar = (entry: SavedSession): ReactElement | null => {
  const progress = qualityCorrectionProgress[entry.id]
  if (!progress || progress.stage === 'completed' || progress.stage === 'failed') return null
  const stageKeys = { loading: 'qualityCorrectionLoading', asr: 'qualityCorrectionAsr', diarization: 'recordProcessingDiarization', completed: 'recordProcessingCompleted', failed: 'recordProcessingFailed' } as const
  const phase = ui(stageKeys[progress.stage])
  const percentage = progress.total ? Math.floor(progress.completed / progress.total * 100) : undefined
  return <div className={`session-quality-progress ${progress.stage}`}>
    <div className="session-quality-progress-label" aria-live="polite"><span>{ui('qualityCorrection')} · {phase}{progress.stage === 'asr' && ` (${progress.completed}/${progress.total - 1})`}</span>
      {percentage !== undefined && <span>{percentage}%</span>}
    </div>
    <progress aria-label={`${ui('qualityCorrection')} · ${phase}`} max={progress.total || 1} value={progress.total ? progress.completed : undefined} />
  </div>
}

const qualityCorrectionBadge = (entry: SavedSession): ReactElement | null => {
  if (qualityCorrectionRunning(entry)) return null
  const progress = qualityCorrectionProgress[entry.id]
  const state = progress?.stage === 'completed' || progress?.stage === 'failed' ? progress.stage : entry.qualityCorrectionState
  if (!state) return null
  const label = ui('qualityCorrection')
  const error = progress?.error ?? entry.qualityCorrectionError
  if (state === 'completed' || !error) return <span className={`session-processing-state session-quality-badge ${state}`} role="status">{label}</span>
  const id = `quality-detail-${entry.id}`
  const expanded = processingDetailsId === id
  return <span className="session-processing-disclosure">
    <button type="button" className="session-processing-state session-quality-badge failed" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      onClick={() => setProcessingDetailsId(expanded ? null : id)}>{label}</button>
    {expanded && <span id={id} className="session-processing-detail">{error}</span>}
  </span>
}

const sessionTranscript = (entry: SavedSession, query: string): ReactElement => entry.segments?.length ? <>
    {groupLiveCaptions(entry.segments).filter(group => group.status !== 'gap' && `${group.speaker ?? ''} ${group.sourceText} ${group.translatedText ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(group => <article key={group.id}>
      <time>{timestamp(group.startMs)}</time>
      {group.speaker && <div className="speaker-row speaker-labels">{Array.from(new Set(group.members.map(member => member.speaker).filter(Boolean))).map(speaker => <span key={speaker}>{speaker}</span>)}</div>}
      <p>{group.sourceText}</p>
      {group.translatedText && <p className="translation">{group.translatedText}</p>}
      <details open={group.members.some(member => member.id === editingSessionSegmentId) || undefined}><summary>{ui('edit')}</summary>
      {group.members.map((segment) => <article key={segment.id} className="transcript-segment">
      <time>{timestamp(segment.startMs)}</time>
      {editingSessionSegmentId === segment.id && entry.processingState !== 'running' ? <div className="transcript-edit"><div className="timing-inputs"><label>{ui('startMilliseconds')}<input type="number" min="0" defaultValue={segment.startMs} onBlur={(event) => updateSavedTranscriptTiming(entry.id, segment.id, { startMs: Number(event.currentTarget.value) })} /></label><label>{ui('endMilliseconds')}<input type="number" min="1" defaultValue={segment.endMs} onBlur={(event) => updateSavedTranscriptTiming(entry.id, segment.id, { endMs: Number(event.currentTarget.value) })} /></label></div><textarea defaultValue={segment.sourceText} aria-label={ui('sourceText')} onBlur={(event) => updateSavedTranscript(entry.id, segment.id, { sourceText: event.currentTarget.value })} /><textarea defaultValue={segment.translatedText ?? ''} aria-label={ui('translation')} placeholder={ui('optionalTranslation')} onBlur={(event) => updateSavedTranscript(entry.id, segment.id, { translatedText: event.currentTarget.value })} /><button className="text-button" onClick={() => setEditingSessionSegmentId(null)}>{ui('doneEditing')}</button></div> : <><div className="speaker-row"><input disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} list="registered-speakers" aria-label={ui('speakerName')} value={segment.speaker ?? ''} placeholder={ui('unassignedSpeaker')} onChange={(event) => updateSessionSpeaker(entry.id, segment.id, event.target.value)} /></div><p>{segment.sourceText}</p>{segment.translatedText && <p className="translation">{segment.translatedText}</p>}<button disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} className="edit-button" onClick={() => setEditingSessionSegmentId(segment.id)}>{ui('edit')}</button><div className="segment-actions">{segmentRerecordingId === segment.id ? <button className="text-button" onClick={() => void stopSegmentRerecord()}>{ui('endRerecording')}</button> : <button className="text-button" disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry)) || Boolean(segmentRerecordingId)} onClick={() => void startSegmentRerecord(entry, segment)}>{ui('rerecordSegment')}</button>}<label className="text-button">{ui('rerecordWav')}<input disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} hidden type="file" accept="audio/wav,.wav" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void replaceSessionSegmentAudio(entry, segment, file) }} /></label></div></>}
    </article>)}</details>
    </article>)}
  </> : <pre>{entry.transcript || ui('noCaptionsForRecord')}</pre>

const liveCaptionGroups = useMemo(() => groupLiveCaptions(renderedLiveTranscripts), [renderedLiveTranscripts])
const popupCaptionGroups = useMemo(() => groupLiveCaptions(visibleTranscripts), [visibleTranscripts])
const sidebarSections: Array<{ id: 'history' | 'capture' | 'speakers'; label: string; icon: ReactElement }> = [
  { id: 'history', label: ui('historyRecords'), icon: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM9 4v16M12 8h5M12 12h5M12 16h3" /> },
  { id: 'capture', label: ui('captureControls'), icon: <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /> },
  { id: 'speakers', label: ui('speaker'), icon: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></> }
]

const liveWorkspace = (
    <div className="live-workspace" data-capture-state={captureState}>
      <section className="caption-window" style={{ '--caption-scale': captionScale } as CSSProperties}>
        <section ref={transcriptContainerRef} className="transcript" aria-live="polite" onScroll={(event) => { const element = event.currentTarget; setFollowingCaptions(element.scrollHeight - element.scrollTop - element.clientHeight < 48) }}>
        {visibleTranscripts.length === 0 ? (
          <div className="empty live-caption-empty"><div className="caption-particles" aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ '--particle-index': index } as CSSProperties} />)}</div><div className="caption-wave" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ '--bar-index': index } as CSSProperties} />)}</div><h2>{ui('waitingForSpeech')}</h2><p>{ui('waitingForSpeechHint')}</p></div>
        ) : <>{liveCaptionGroups.map((group) => (
          <article key={group.id} className={group.status}>
            <time>{timestamp(group.startMs)}</time>
            {group.speaker && <div className="speaker-row speaker-labels">{Array.from(new Set(group.members.map(member => member.speaker).filter(Boolean))).map(speaker => <span key={speaker}>{speaker}</span>)}</div>}
            <p>{group.sourceText}</p>
            {group.translatedText && <p className="translation">{group.translatedText}</p>}
            {group.members.filter(member => member.status === 'final' && !member.translatedText && (member.translationStatus === 'failed' || ((settings.translationLoadStrategy === 'manual' || captureState === 'idle') && !member.translationStatus))).map(member => <button key={member.id} className="text-button translation-retry" onClick={() => {
              const retry = { ...member, translationStatus: undefined, translationAttempts: undefined }
              if (member.translationStatus === 'failed') setTranscripts(current => current.map(entry => entry.id === member.id ? retry : entry))
              void requestTranslation(retry)
            }}>{member.translationStatus === 'failed' ? ui('retryTranslation') : ui('translateSegment')} · {timestamp(member.startMs)}</button>)}
            <details open={group.members.some(member => member.id === editingTranscriptId) || undefined}>
              <summary>{ui('edit')}</summary>
              {group.members.map((entry) => (
          <article key={entry.id} className={`transcript-segment ${entry.status}`}>
            <time>{timestamp(entry.startMs)}</time>
            {editingTranscriptId === entry.id ? <div className="transcript-edit"><div className="timing-inputs"><label>{ui('startMilliseconds')}<input type="number" min="0" defaultValue={entry.startMs} onBlur={(event) => updateTranscriptTiming(entry.id, Number(event.currentTarget.value), entry.endMs)} /></label><label>{ui('endMilliseconds')}<input type="number" min="1" defaultValue={entry.endMs} onBlur={(event) => updateTranscriptTiming(entry.id, entry.startMs, Number(event.currentTarget.value))} /></label></div><textarea value={entry.sourceText} onChange={(event) => updateTranscript(entry.id, event.target.value, entry.translatedText ?? '')} /><textarea value={entry.translatedText ?? ''} placeholder={ui('optionalTranslation')} onChange={(event) => updateTranscript(entry.id, entry.sourceText, event.target.value)} /><button className="text-button" onClick={() => setEditingTranscriptId(null)}>{ui('doneEditing')}</button></div> : <><div className="speaker-row"><input list="registered-speakers" aria-label={ui('speakerName')} value={entry.speaker ?? ''} placeholder={ui('unassignedSpeaker')} onChange={(event) => updateSpeaker(entry.id, event.target.value)} /></div><p>{entry.sourceText}</p>{entry.translatedText && <p className="translation">{entry.translatedText}</p>}{entry.translationStatus === 'failed' && <button className="text-button translation-retry" onClick={() => { const retry = { ...entry, translationStatus: undefined, translationAttempts: undefined }; setTranscripts((current) => current.map((currentEntry) => currentEntry.id === entry.id ? retry : currentEntry)); void requestTranslation(retry) }}>{ui('retryTranslation')}</button>}<button className="edit-button" onClick={() => setEditingTranscriptId(entry.id)}>{ui('edit')}</button></>}
          {(settings.translationLoadStrategy === 'manual' || captureState === 'idle') && entry.status === 'final' && !entry.translatedText && !entry.translationStatus && <button className="text-button translation-retry" onClick={() => void requestTranslation(entry)}>{ui('translateSegment')}</button>}</article>
              ))}
            </details>
          </article>
        ))}</>}
      </section>

      </section>

      {webCaptionPopup && webCaptionWindow && webCaptionPortalRoot && createPortal(<CaptionPopout captionScale={captionScale} entries={popupCaptionGroups} fullscreen={webCaptionFullscreen} fullscreenLabel={webCaptionFullscreen ? ui('exitFullscreen') : ui('fullscreen')} waitingLabel={ui('waitingForCaptions')} speakerLabel={ui('unassignedSpeaker')} stageLabel={ui('floatingCaptions')} speakerColon={ui('labelColon')} toggleFullscreen={toggleWebCaptionFullscreen} fullscreenError={webCaptionFullscreenError} />, webCaptionPortalRoot)}
      <section className="capture-panel capture-controls-only" aria-label={ui('captureControls')}>
        <div className="source-capture-row"><div className="capture-controls">{canRecord ? <button className="primary" disabled={selectedDeviceId === 'none' && !includeSystemAudio} onClick={() => void startOrContinueRecording()}>{ui(canContinueRecording ? 'continueRecording' : 'startRecording')}</button> : captureState === 'starting' || captureState === 'saving' ? <button className="secondary" disabled>{captureState === 'starting' ? ui('connecting') : ui('saving')}</button> : <><button className="secondary" onClick={() => void togglePause()}>{captureState === 'paused' ? ui('resumeRecording') : ui('pauseRecording')}</button><button className="danger" onClick={() => void stopCapture()}>{ui('stopRecording')}</button></>}</div><div className="caption-actions"><span>{visibleTranscripts.length} {ui('segments')}</span><input className="caption-search" aria-label={ui('searchCaptions')} value={transcriptSearch} placeholder={ui('searchCaptions')} onChange={(event) => setTranscriptSearch(event.target.value)} /><TooltipButton className="text-button caption-icon-action caption-size-button" tooltip={ui('decreaseCaptionSize')} disabled={captionScale <= .8} onClick={() => setCaptionScale((scale) => Math.max(.8, Number((scale - .1).toFixed(1))))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19L8 5l5 14M5 14h6M16 12h6" /></svg></TooltipButton><TooltipButton className="text-button caption-icon-action caption-size-button" tooltip={ui('increaseCaptionSize')} disabled={captionScale >= 1.6} onClick={() => setCaptionScale((scale) => Math.min(1.6, Number((scale + .1).toFixed(1))))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19L8 5l5 14M5 14h6M16 12h6M19 9v6" /></svg></TooltipButton>{sidebarSections.map((item) => { const active = liveControlsOpen && !historyCollapsed && sidebarSection === item.id; return <TooltipButton key={item.id} className={`text-button caption-icon-action ${item.id === 'capture' ? 'live-controls-trigger' : `live-${item.id}-trigger`}${active ? ' active' : ''}`} tooltip={item.label} aria-expanded={active} aria-controls={`live-sidebar-${item.id}`} onClick={() => { if (active) { setLiveControlsOpen(false); setHistoryCollapsed(true) } else { setSidebarSection(item.id); setLiveControlsOpen(true); setHistoryCollapsed(false) } }}><svg viewBox="0 0 24 24" aria-hidden="true">{item.icon}</svg></TooltipButton> })}<TooltipButton className="text-button caption-icon-action caption-popout-trigger" tooltip={ui('openCaptionPopup')} onClick={openFloatingCaptions}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 10V4H3v16h8M13 12h8v8h-8z" /></svg></TooltipButton><TooltipButton className="text-button caption-icon-action" tooltip={ui('cancelTranslation')} onClick={cancelPendingTranslations}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M8 3v2M6 5c0 5 5 8 5 8M12 5c0 5-5 8-8 9M14 20l3-8 3 8M15 17h4M3 3l18 18" /></svg></TooltipButton><TooltipButton className="text-button caption-icon-action" tooltip={ui('clearScreen')} disabled={!visibleTranscripts.length} onClick={clearCaptions}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></TooltipButton>{!followingCaptions && <TooltipButton className="text-button caption-icon-action" tooltip={ui('backToLatest')} onClick={() => setFollowingCaptions(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v13M7 11l5 5 5-5M4 21h16" /></svg></TooltipButton>}</div><div className="timer">{timestamp(captionDisplayElapsedMs)}</div></div>
      </section>
      {(summaryStatus || summaryText) && <section className="summary-panel"><div className="meter-label"><span>{ui('meetingNotes')}</span><strong>{summaryStatus}</strong></div>{summaryText && <><div className="summary-actions"><button className="text-button" onClick={() => void copySummary(summaryText)}>{ui('copy')}</button><button className="text-button" onClick={() => openSummaryDownloadPicker(summaryText, ui('meetingNotes'))}>↓ {ui('download')}</button></div><MarkdownSummary text={summaryText} /></>}</section>}

    </div>
  )

const openModelManager = (purpose: 'asr' | 'translation' | 'summary' | 'diarization' | 'embedding', id: string | null = null, openedFromModelCard = false): void => {
  setModelPurpose(purpose); setEditingModelId(id)
  setModelDialogCanDelete(openedFromModelCard)
  if (purpose === 'asr') { const profile = settings.modelProfiles.find((item) => item.id === id); setNewModelName(profile?.name ?? ''); setNewModelEndpoint(profile?.endpoint ?? ''); setNewModelId(profile?.model ?? ''); setNewModelRequiresApiKey(profile?.requiresApiKey !== false); setNewModelUsesBuiltin(profile?.kind === 'openai-http'); setModelCapabilities(profile?.capabilities ?? { asrMode: 'non-streaming', vadSource: 'app', timestampPrecision: 'chunk' }) }
  if (purpose === 'translation') { const profile = settings.translationProfiles.find((item) => item.id === id); setNewModelName(profile?.name ?? ''); setNewModelEndpoint(profile?.endpoint ?? ''); setNewModelId(profile?.model ?? ''); setNewModelRequiresApiKey(profile?.requiresApiKey !== false) }
  if (purpose === 'summary') { setNewModelName(ui('summaryTitle')); setNewModelEndpoint(settings.summaryEndpoint); setNewModelId(settings.summaryModel); setNewModelRequiresApiKey(settings.summaryRequiresApiKey) }
  if (purpose === 'diarization') { setNewModelName(ui('speakerDiarization')); setNewModelEndpoint(settings.diarizationEndpoint); setNewModelId(settings.diarizationModel); setNewModelRequiresApiKey(settings.diarizationRequiresApiKey) }
  if (purpose === 'embedding') { setNewModelName(ui('embedding')); setNewModelEndpoint(settings.embeddingEndpoint); setNewModelId(settings.embeddingModel); setNewModelRequiresApiKey(settings.embeddingRequiresApiKey) }
  setNewModelApiKey(''); setModelDialogOpen(true)
}
const saveManagedModel = (): void => {
  const name = newModelName.trim(); const endpoint = newModelEndpoint.trim(); const model = newModelId.trim()
  if (!name || !endpoint || !model) { setStatus(ui('modelFieldsRequired')); return }
  if (modelPurpose === 'asr' && !editingModelId) { void addModelProfile(modelCapabilities); setModelDialogOpen(false); return }
  const registryId = modelPurpose === 'translation' ? (editingModelId ?? crypto.randomUUID()) : modelPurpose === 'summary' ? 'managed-summary' : modelPurpose === 'diarization' ? 'managed-diarization' : 'managed-embedding'
  setSettings((current) => {
    if (modelPurpose === 'asr') return { ...current, modelProfiles: current.modelProfiles.map((profile) => profile.id === editingModelId ? { ...profile, name, endpoint, model, kind: newModelUsesBuiltin ? 'openai-http' : 'websocket', requiresApiKey: newModelRequiresApiKey, capabilities: modelCapabilities } : profile) }
    if (modelPurpose === 'translation') { const profile = { id: registryId, name, endpoint, model, requiresApiKey: newModelRequiresApiKey }; const profiles = current.translationProfiles.some((item) => item.id === registryId) ? current.translationProfiles.map((item) => item.id === registryId ? profile : item) : [...current.translationProfiles, profile]; return { ...current, translationProfiles: profiles, selectedTranslationModelId: registryId, translationEndpoint: endpoint, translationModel: model } }
    if (modelPurpose === 'summary') return { ...current, summaryEndpoint: endpoint, summaryModel: model, summaryRequiresApiKey: newModelRequiresApiKey }
    if (modelPurpose === 'diarization') return { ...current, diarizationEndpoint: endpoint, diarizationModel: model, diarizationRequiresApiKey: newModelRequiresApiKey }
    return { ...current, embeddingEndpoint: endpoint, embeddingModel: model, embeddingRequiresApiKey: newModelRequiresApiKey }
  })
  if (newModelApiKey.trim() && modelPurpose !== 'asr') void saveModelApiKey(registryId, newModelApiKey).then(() => setNewModelApiKey('')).catch(() => setStatus(ui('modelApiKeySaveFailed')))
  if (newModelApiKey.trim() && modelPurpose === 'asr' && editingModelId) {
    void saveModelApiKey(editingModelId, newModelApiKey.trim()).then(() => setNewModelApiKey('')).catch(() => setStatus(ui('modelApiKeySaveFailed')))
  }
  setModelDialogOpen(false); setStatus(ui('modelUpdated'))
}
const deleteManagedModel = (): void => {
  if (!editingModelId && !(modelPurpose === 'summary' && settings.summaryModel) && !(modelPurpose === 'diarization' && settings.diarizationModel) && !(modelPurpose === 'embedding' && settings.embeddingModel)) return
  setSettings((current) => {
    if (modelPurpose === 'asr') {
      const remaining = current.modelProfiles.filter((profile) => profile.id !== editingModelId)
      // Deleting the active model falls back to the environment-provided model
      // (env profiles are kept at the front of the list), never a random one.
      const fallbackId = current.selectedModelId === editingModelId
        ? remaining.find((profile) => profile.id === 'environment-asr' || profile.id === 'web-environment-asr' || profile.id.startsWith('web-gateway-asr-'))?.id ?? 'none'
        : current.selectedModelId
      return { ...current, modelProfiles: remaining, selectedModelId: fallbackId }
    }
    if (modelPurpose === 'translation') {
      const profiles = current.translationProfiles.filter((profile) => profile.id !== editingModelId)
      if (current.selectedTranslationModelId !== editingModelId) return { ...current, translationProfiles: profiles }
      const envProfile = profiles.find((profile) => profile.id === 'environment-translation' || profile.id === 'web-environment-translation')
      return { ...current, translationProfiles: profiles, selectedTranslationModelId: envProfile?.id ?? 'none', translationEndpoint: envProfile?.endpoint ?? '', translationModel: envProfile?.model ?? '' }
    }
    if (modelPurpose === 'summary') return { ...current, summaryEndpoint: '', summaryModel: '' }
    if (modelPurpose === 'diarization') return { ...current, diarizationEndpoint: '', diarizationModel: '' }
    return { ...current, embeddingEndpoint: '', embeddingModel: '' }
  })
  setModelDialogOpen(false); setStatus(ui('modelDeleted'))
}
const selectSummaryTemplate = (id: string): void => setSettings((current) => {
  const selected = resolveSummaryTemplate(current.summaryTemplates, id)
  return selected ? { ...current, ...selected } : current
})
const addSummaryTemplate = (): void => {
  try {
    setSettings((current) => ({ ...current, ...createSummaryTemplate(current.summaryTemplates, crypto.randomUUID(), newSummaryTemplateName, newSummaryTemplateContent) }))
  } catch { setStatus(ui('templateNameRequired')); return }
  setNewSummaryTemplateName(''); setNewSummaryTemplateContent(''); setIsCreatingSummaryTemplate(false)
}
const deleteSummaryTemplate = (): void => setSettings((current) => {
  try { return { ...current, ...removeSelectedSummaryTemplate(current.summaryTemplates, current.selectedSummaryTemplateId) } }
  catch { setStatus(ui('keepOneTemplate')); return current }
})
const summaryWorkspace = <SummaryWorkspace ui={ui} sessions={sessions} settings={settings} sessionId={summarySessionId} setSessionId={setSummarySessionId} isCreatingTemplate={isCreatingSummaryTemplate} setIsCreatingTemplate={setIsCreatingSummaryTemplate} templateName={newSummaryTemplateName} setTemplateName={setNewSummaryTemplateName} templateContent={newSummaryTemplateContent} setTemplateContent={setNewSummaryTemplateContent} selectTemplate={selectSummaryTemplate} addTemplate={addSummaryTemplate} openSettings={() => openSettings('summary')} summarizeSession={summarizeSession} translateSummary={translateSummary} copySummary={copySummary} openSummaryDownload={openSummaryDownloadPicker} />
const useAsrProfile = (id: string): void => {
  if (captureState !== 'idle') { setStatus(ui('asrModelLockedHint')); return }
  setSettings((current) => {
    const next = { ...current, selectedModelId: id }
    // Electron persists the whole settings payload in the account config; keep
    // the switch across restarts without requiring an explicit "save" click.
    if (window.s2t) void window.s2t.saveModelConfig(next).catch(() => setStatus(ui('asrModelSwitchSaveFailed')))
    return next
  })
  setStatus(ui('asrModelSwitchApplied'))
}
const modelCard = (options: { cardKey?: string; tone: 'asr' | 'translation' | 'summary' | 'diarization'; active: boolean; healthId: string; onEdit: () => void; children: ReactNode }): ReactElement => {
  // Clicking anywhere on the card (Enter/Space included) opens the edit
  // dialog; switching between models happens only through the「目前使用」
  // dropdowns above. The active card stays clickable — editing it is legal.
  const handleEdit = (): void => options.onEdit()
  return (
    <article key={options.cardKey} className={`model-list-item model-${options.tone}`} role="button" tabIndex={0} title={ui('editModel')} onClick={handleEdit} onKeyDown={(event: ReactKeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleEdit() } }}>
      <div className="model-card-content">{options.children}</div>
      <div className="model-card-side">
        <div className="model-card-badges">
          <span className="model-card-health">{modelHealthBadge(options.healthId)}</span>
          {options.active && <span className="model-card-active">{ui('inUse')}</span>}
        </div>
      </div>
    </article>
  )
}
// Single-choice selector panel: every purpose holds at most one active model.
// A selection that is missing or no longer valid falls back to the
// environment-provided model, which is also the out-of-the-box default.
const diarizationOptions = [...(settings.diarizationProfiles ?? []), ...(settings.diarizationModel && !(settings.diarizationProfiles ?? []).some(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint) ? [{ id: 'managed-diarization', name: settings.diarizationModel, model: settings.diarizationModel, endpoint: settings.diarizationEndpoint, requiresApiKey: settings.diarizationRequiresApiKey }] : [])]
const asrSelectionOptions = settings.modelProfiles.filter((profile) => profile.id !== 'none')
const translationSelectionOptions = settings.translationProfiles
const envAsrSelectionId = asrSelectionOptions.find((profile) => profile.id === 'environment-asr' || profile.id === 'web-environment-asr' || profile.id.startsWith('web-gateway-asr-'))?.id
const envTranslationSelectionId = translationSelectionOptions.find((profile) => profile.id === 'environment-translation' || profile.id === 'web-environment-translation')?.id
const activeAsrProfileId = asrSelectionOptions.some((profile) => profile.id === settings.selectedModelId) ? settings.selectedModelId : envAsrSelectionId ?? 'none'
const activeTranslationProfileId = translationSelectionOptions.some((profile) => profile.id === settings.selectedTranslationModelId) ? settings.selectedTranslationModelId : envTranslationSelectionId ?? 'none'
const selectionPlaceholder = (options: Array<{ id: string }>, activeId: string): ReactElement | null => options.some((profile) => profile.id === activeId) ? null : <option value={activeId}>{ui('noSelection')}</option>
// Single-slot purposes (summary / diarization / embedding) reuse the exact
// label + select shape of the profile pickers, so every panel row looks the
// same. The row never disappears: an unconfigured slot keeps the shared
//「未指定」placeholder, and switching happens through the model dialog
// (registering a model replaces the slot) — hence the guarded onChange.
const singleSlotSelectionOptions = (model: string): Array<{ id: string; name: string }> => model ? [{ id: model, name: model }] : []
const singleSlotRow = (label: string, model: string): ReactElement => {
  const options = singleSlotSelectionOptions(model)
  const activeId = model || 'none'
  return (
    <div className="model-active-row">
      <span className="model-active-label">{label}</span>
      <select aria-label={`${label} · ${ui('activeModel')}`} value={activeId} title={ui('singleSlotModel')} onChange={(event) => { if (!event.target.value || event.target.value === activeId) return }}>
        {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        {selectionPlaceholder(options, activeId)}
      </select>
    </div>
  )
}
const modelSelectionPanel = (
  <section className="model-active-panel" aria-label={ui('activeModel')}>
    <div className="model-active-heading"><strong>{ui('activeModel')}</strong><span className="hint">{ui('modelSwitchHint')}</span></div>
    <div className="model-active-rows">
      {asrSelectionOptions.length > 0 && <div className="model-active-row">
        <span className="model-active-label">ASR</span>
        <select aria-label={`ASR · ${ui('activeModel')}`} value={activeAsrProfileId} disabled={captureState !== 'idle'} title={captureState !== 'idle' ? ui('asrModelLockedHint') : undefined} onChange={(event) => useAsrProfile(event.target.value)}>
          {asrSelectionOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          {selectionPlaceholder(asrSelectionOptions, activeAsrProfileId)}
        </select>
      </div>}
      {translationSelectionOptions.length > 0 && <div className="model-active-row">
        <span className="model-active-label">{ui('translation')}</span>
        <select aria-label={`${ui('translation')} · ${ui('activeModel')}`} value={activeTranslationProfileId} onChange={(event) => selectTranslationProfile(event.target.value)}>
          {translationSelectionOptions.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          {selectionPlaceholder(translationSelectionOptions, activeTranslationProfileId)}
        </select>
      </div>}
      {singleSlotRow(ui('summaryTitle'), settings.summaryModel)}
      <div className="model-active-row"><span className="model-active-label">{ui('speakerDiarization')}</span><select aria-label={ui('speakerDiarization')} disabled={captureState !== 'idle'} value={diarizationOptions.find(profile => profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint)?.id ?? 'none'} onChange={event => { const profile = diarizationOptions.find(profile => profile.id === event.target.value); if (profile) setSettings(current => ({ ...current, diarizationModel: profile.model, diarizationEndpoint: profile.endpoint, diarizationRequiresApiKey: profile.requiresApiKey !== false })) }}>{diarizationOptions.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}{!diarizationOptions.length && <option value="none">{ui('noSelection')}</option>}</select></div>
      {settings.embeddingModel && singleSlotRow(ui('embedding'), settings.embeddingModel)}
    </div>
  </section>
)
const workspace = view === 'live' ? liveWorkspace : view === 'history' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">HISTORY</p><h2>{ui('recordingsAndTranscripts')}</h2></div><div className="history-title-actions">{window.s2t && <button className="secondary" onClick={() => void openSavedSession()}>{ui('openSavedSession')}</button>}<span className="history-record-count">{filteredSessions.length} {ui('records')}</span></div></div>
      {sessions.length === 0 ? <div className="empty compact"><h2>{ui('noRecords')}</h2><p>{ui('noRecordsHint')}</p></div> : <>
        <div className="history-pagination"><label className="history-search"><input className="caption-search" aria-label={ui('searchRecords')} value={historySearch} placeholder={ui('recordSearchPlaceholder')} onChange={(event) => { setHistorySearch(event.target.value); setHistoryPage(1) }} /></label><div className="history-pagination-controls"><select aria-label={ui('sort')} title={ui('sort')} value={historySort} onChange={(event) => { setHistorySort(event.target.value as 'title' | 'createdAt' | 'durationMs'); setHistoryPage(1) }}><option value="createdAt">{ui('time')}</option><option value="title">{ui('title')}</option><option value="durationMs">{ui('duration')}</option></select><button className="text-button history-dir-button" aria-label={ui(historySortDirection === 'asc' ? 'ascending' : 'descending')} title={ui(historySortDirection === 'asc' ? 'ascending' : 'descending')} onClick={() => setHistorySortDirection((current) => current === 'asc' ? 'desc' : 'asc')}>{historySortDirection === 'asc' ? '↑' : '↓'}</button><select className="history-page-size" aria-label={ui('perPage')} title={ui('perPage')} value={historyPageSize} onChange={(event) => { setHistoryPageSize(Number(event.target.value)); setHistoryPage(1) }}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select><span className="history-page-indicator">{currentHistoryPage}{ui('pageSeparator')}{historyPageCount}</span><button className="text-button" aria-label={ui('previousPage')} title={ui('previousPage')} disabled={currentHistoryPage === 1} onClick={() => setHistoryPage((current) => Math.max(1, current - 1))}>‹</button><button className="text-button" aria-label={ui('nextPage')} title={ui('nextPage')} disabled={currentHistoryPage === historyPageCount} onClick={() => setHistoryPage((current) => Math.min(historyPageCount, current + 1))}>›</button></div></div>
        <div className="session-list">{pagedSessions.map((entry) => <article key={entry.id} className="session-item">
          <div className="session-details">{renamingSessionId === entry.id ? <form className="session-rename" onSubmit={(event) => { event.preventDefault(); renameSession(entry.id) }}><input autoFocus aria-label={ui('recordTitle')} maxLength={200} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => renameSession(entry.id)} onKeyDown={(event) => { if (event.key === 'Escape') { setTitleDraft(entry.title); setRenamingSessionId(null) } }} /></form> : <button type="button" disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} className="session-title" title={ui('editRecordTitle')} aria-label={`${ui('recordTitle')}: ${entry.title}`} onClick={() => { setTitleDraft(entry.title); setRenamingSessionId(entry.id) }}>{entry.title}</button>}<p className="session-meta"><span className="session-meta-date">{new Date(entry.createdAt).toLocaleString(resolveUiLanguage(settings.uiLanguage))}</span><span>{timestamp(entry.durationMs)}</span><span>{entry.source}</span>{entry.audioUnavailable && <span>{ui('audioNotSavedRecoveryDownloaded')}</span>}<span className={`session-storage-state ${sessionStorageStates[entry.id] ?? 'local'}`}>{sessionStorageStates[entry.id] === 'remote' ? ui('sessionStorageRemote') : sessionStorageStates[entry.id] === 'both' ? ui('sessionStorageBoth') : sessionStorageStates[entry.id] === 'pending' ? ui('sessionStoragePending') : ui('sessionStorageLocal')}</span>{processingBadge(entry)}{qualityCorrectionBadge(entry)}</p>{qualityCorrectionBar(entry)}{playingSessionId === entry.id && playbackUrl && <audio controls src={playbackUrl}>{ui('audioPlaybackUnsupported')}</audio>}</div>
          <div className="session-actions"><TooltipButton className="session-quick-button" aria-label={ui('viewCaptions')} tooltip={ui('viewCaptions')} onClick={() => { setViewingSessionId(entry.id); setSessionMenuId(null) }}><span>▤</span></TooltipButton><TooltipButton className="session-quick-button" aria-label={playingSessionId === entry.id ? ui('collapsePlayer') : ui('playRecording')} tooltip={playingSessionId === entry.id ? ui('collapsePlayer') : ui('playRecording')} disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} onClick={() => { void playSession(entry); setSessionMenuId(null) }}><span>▶</span></TooltipButton><TooltipButton className="session-quick-button" aria-label={ui('download')} tooltip={ui('download')} disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} onClick={() => openDownloadPicker(entry, 'all')}><span>↓</span></TooltipButton><TooltipButton className="session-more-button" tooltip={ui('moreActionsForRecord').replace('{title}', entry.title)} aria-label={ui('moreActionsForRecord').replace('{title}', entry.title)} aria-expanded={sessionMenuId === entry.id} onClick={() => setSessionMenuId((current) => current === entry.id ? null : entry.id)}>•••</TooltipButton>{sessionMenuId === entry.id && <div ref={sessionMenuRef} className="session-action-menu" role="menu"><button role="menuitem" onClick={() => { setViewingSessionId(entry.id); setSessionMenuId(null) }}><span>▤</span>{ui('viewCaptions')}</button><button role="menuitem" disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} onClick={() => { void finalizeSession(entry); setSessionMenuId(null) }}><span>✦</span>{ui('qualityCorrection')}</button><button role="menuitem" disabled={captureState !== 'idle' || (entry.processingState === 'running' || qualityCorrectionRunning(entry))} onClick={() => { void continueSession(entry); setSessionMenuId(null) }}><span>↗</span>{ui('continueRecording')}</button><button role="menuitem" disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} onClick={() => { void playSession(entry); setSessionMenuId(null) }}><span>▶</span>{playingSessionId === entry.id ? ui('collapsePlayer') : ui('playRecording')}</button><button role="menuitem" disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} onClick={() => openDownloadPicker(entry, 'audio')}><span>↓</span>{ui('downloadAudio')}</button><button role="menuitem" disabled={(entry.processingState === 'running' || qualityCorrectionRunning(entry))} onClick={() => openDownloadPicker(entry, 'transcript')}><span>↓</span>{ui('downloadTranscript')}</button><button role="menuitem" onClick={() => { void copyTranscript(entry.segments); setSessionMenuId(null) }}><span>⧉</span>{ui('copyTranscript')}</button><button className="danger" role="menuitem" disabled={qualityCorrectionRunning(entry)} onClick={() => { void deleteSession(entry); setSessionMenuId(null) }}><span>⌫</span>{ui('deleteRecord')}</button></div>}</div>
        </article>)}</div>
      </>}
      {viewingSession && <div className="transcript-modal-backdrop" role="presentation" onMouseDown={() => setViewingSessionId(null)}><section className="transcript-modal" role="dialog" aria-modal="true" aria-label={ui('recordTranscriptAria').replace('{title}', viewingSession.title)} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">TRANSCRIPT</p><h2>{viewingSession.title}</h2>{processingBadge(viewingSession, 'modal')}{viewingSession.modelSnapshot && <p className="hint">{ui('modelId')}: {viewingSession.modelSnapshot.name} ({viewingSession.modelSnapshot.model}) · {viewingSession.modelSnapshot.inputSampleRate} Hz → {viewingSession.modelSnapshot.modelSampleRate} Hz</p>}</div><button className="text-button" onClick={() => { setViewingSessionId(null); setSessionTranscriptSearch('') }}>{ui('close')}</button></header><div className="transcript-tools"><input aria-label={ui('searchThisRecord')} value={sessionTranscriptSearch} placeholder={ui('searchTranscriptPlaceholder')} onChange={(event) => setSessionTranscriptSearch(event.target.value)} /></div><div className="session-transcript record-transcript">{sessionTranscript(viewingSession, sessionTranscriptSearch)}</div></section></div>}
    </section>
  ) : view === 'summary' ? summaryWorkspace : view === 'models' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">MODELS</p><h2>{t('models')}</h2></div></div>
      {modelSelectionPanel}
      <div className="model-filter-row"><nav className="model-filter" aria-label={ui('modelCategory')}>{(['all', 'asr', 'translation', 'summary', 'diarization', 'embedding'] as const).map((filter) => { const counts = { asr: settings.modelProfiles.filter((profile) => profile.id !== 'none').length, translation: settings.translationProfiles.length, summary: settings.summaryModel ? 1 : 0, diarization: diarizationOptions.length, embedding: settings.embeddingModel ? 1 : 0 }; const count = filter === 'all' ? counts.asr + counts.translation + counts.summary + counts.diarization + counts.embedding : counts[filter]; const label = { all: ui('all'), asr: 'ASR', translation: ui('translation'), summary: ui('summary'), diarization: ui('speakerDiarization'), embedding: ui('embedding') }[filter]; return <button key={filter} className={modelFilter === filter ? 'nav-active' : ''} onClick={() => setModelFilter(filter)}>{label} <span className="model-filter-count">{count}</span></button> })}</nav><input className="caption-search model-search-input" aria-label={ui('searchModels')} value={modelSearch} placeholder={ui('searchModelsPlaceholder')} onChange={(event) => setModelSearch(event.target.value)} /><button className="primary" onClick={() => openModelManager('asr')}>{ui('registerModel')}</button></div>
      <div className="model-list">
        {(modelFilter === 'all' || modelFilter === 'asr') && settings.modelProfiles.filter((profile) => profile.id !== 'none' && matchesModelSearch(profile.name, profile.model, profile.endpoint)).map((profile) => modelCard({ cardKey: profile.id, tone: 'asr', active: profile.id === activeAsrProfileId, healthId: profile.id, onEdit: () => openModelManager('asr', profile.id, true), children: <><strong>{profile.name}</strong><p>ASR · {profile.kind === 'openai-http' ? 'OpenAI Speech-to-Text / ' + ui('chunkedHttp') : ui('realtimeWebsocket')} · {profile.model}</p><code>{modelEndpoint(profile.endpoint, profile.kind)}</code></> }))}
        {(modelFilter === 'all' || modelFilter === 'translation') && settings.translationProfiles.filter((profile) => matchesModelSearch(profile.name, profile.model, profile.endpoint)).map((profile) => modelCard({ cardKey: profile.id, tone: 'translation', active: profile.id === activeTranslationProfileId, healthId: profile.id, onEdit: () => openModelManager('translation', profile.id, true), children: <><strong>{profile.name}</strong><p>{ui('translation')} · {ui('chatCompletions')} · {profile.model}</p><code>{textEndpoint(profile.endpoint)}</code></> }))}
        {(modelFilter === 'all' || modelFilter === 'summary') && settings.summaryModel && matchesModelSearch(settings.summaryModel, settings.summaryEndpoint) && modelCard({ tone: 'summary', active: true, healthId: 'managed-summary', onEdit: () => openModelManager('summary', null, true), children: <><strong>{settings.summaryModel}</strong><p>{ui('summary')} · {ui('chatCompletions')}</p><code>{textEndpoint(settings.summaryEndpoint)}</code></> })}
        {(modelFilter === 'all' || modelFilter === 'diarization') && diarizationOptions.filter(profile => matchesModelSearch(profile.name, profile.model, profile.endpoint)).map(profile => modelCard({ cardKey: profile.id, tone: 'diarization', active: profile.model === settings.diarizationModel && profile.endpoint === settings.diarizationEndpoint, healthId: profile.id, onEdit: () => { if (profile.id.startsWith('local-')) { if (captureState === 'idle') setSettings(current => ({ ...current, diarizationModel: profile.model, diarizationEndpoint: profile.endpoint, diarizationRequiresApiKey: false })) } else openModelManager('diarization', null, true) }, children: <><strong>{profile.name}</strong><p>{ui('speakerDiarization')}</p><code>{profile.endpoint}</code></> }))}
        {(modelFilter === 'all' || modelFilter === 'embedding') && settings.embeddingModel && matchesModelSearch(settings.embeddingModel, settings.embeddingEndpoint) && modelCard({ tone: 'diarization', active: true, healthId: 'managed-embedding', onEdit: () => openModelManager('embedding', null, true), children: <><strong>{settings.embeddingModel}</strong><p>{ui('embedding')}</p><code>{settings.embeddingEndpoint}</code></> })}
        {settings.modelProfiles.every((profile) => profile.id === 'none') && !settings.translationProfiles.length && !settings.diarizationModel && !settings.summaryModel && !settings.embeddingModel && <div className="empty compact"><h2>{ui('noConfiguredModels')}</h2><p>{ui('noConfiguredModelsHint')}</p></div>}
      </div>
    </section>
  ) : view === 'voiceprints' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">VOICEPRINTS</p><h2>{t('voiceprints')}</h2></div></div>
      <div className="voiceprint-page"><section className="voiceprint-enroll"><div><p className="eyebrow">ENROLLMENT</p><h3>{ui('enrollMyVoiceprint')}</h3><p>{ui('voiceprintHint')}</p></div><div className="voiceprint-capture"><button className={voiceprintCaptureState === 'recording' ? 'voiceprint-mic recording' : 'voiceprint-mic'} aria-label={voiceprintCaptureState === 'recording' ? ui('endVoiceprintRecording') : ui('startVoiceprintRecording')} disabled={voiceprintCaptureState !== 'recording' && captureState !== 'idle'} onClick={() => void (voiceprintCaptureState === 'recording' ? stopVoiceprintCapture() : startVoiceprintCapture())}>🎙</button><div className="voiceprint-meter"><div><span>{voiceprintCaptureState === 'recording' ? ui('recordingVoiceprint') : ui('microphoneReady')}</span><strong>{dbfsLabel(voiceprintLevel)}</strong></div><div className="meter-track"><div className="meter-value" style={{ width: `${meterPercent(voiceprintLevel)}%` }} /></div><small>{voiceprintCaptureState === 'recording' ? ui('endVoiceprintRecording') : ui('startVoiceprintRecording')}</small></div></div><div className="voiceprint-divider"><span>{ui('voiceprintOr')}</span></div><label className="voiceprint-upload"><input type="file" accept="audio/wav,.wav" onChange={(event) => setVoiceprintFile(event.target.files?.[0] ?? null)} /><span>{ui('uploadWavSample')}</span><small>{ui('pcm16WavMinimum')}</small></label><label className="form-field"><span>{ui('voiceprintScope')}</span><select value={voiceprintSharingScope || 'private'} onChange={(event) => { const scope = event.target.value as 'private' | 'department' | 'organization'; setVoiceprintSharingScope(scope); if (scope === 'private') setVoiceprintSharingConsent(false) }}><option value="private">{ui('privateScope')}</option><option value="department">{ui('departmentScope')}</option><option value="organization">{ui('organizationScope')}</option></select><small>{ui('privateScope')}</small></label>{voiceprintSharingScope !== 'private' && <label className="form-field"><span><input type="checkbox" checked={voiceprintSharingConsent} onChange={(event) => setVoiceprintSharingConsent(event.target.checked)} /> {ui('sharingConsent')}</span></label>}<div className="voiceprint-ready"><span>{voiceprintFile ? `✓ ${voiceprintFile.name}` : ui('uploadWavSample')}</span><button className="primary" disabled={!voiceprintFile || (voiceprintSharingScope !== 'private' && !voiceprintSharingConsent)} onClick={() => void enrollVoiceprint()}>{ui('registerVoiceprint')}</button></div></section><section className="voiceprint-library"><div><p className="eyebrow">REGISTERED</p><h3>{ui('registeredVoiceprints')} <span>{voiceprints.length}</span></h3></div>{voiceprints.length ? <div className="voiceprint-list">{voiceprints.map((voiceprint) => <article key={voiceprint.id}><div className="voiceprint-avatar">{voiceprint.NT.slice(0, 1).toUpperCase()}</div><div><strong>{voiceprint.NT}</strong><p>{voiceprint.Department} · {new Date(voiceprint.createdAt).toLocaleString(settings.uiLanguage)}</p><small>{voiceprint.embeddingModel ? `${voiceprint.embeddingModel} · ${voiceprint.embeddingVersion || '—'} · ${voiceprint.sharingScope === 'organization' ? ui('organizationScope') : voiceprint.sharingScope === 'department' ? ui('departmentScope') : ui('privateScope')}` : '—'}</small></div><button className="text-button danger" onClick={() => void deleteVoiceprint(voiceprint.id)}>{ui('remove')}</button></article>)}</div> : <div className="voiceprint-empty">{ui('noVoiceprints')}</div>}</section></div>
    </section>
  ) : view === 'import' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">IMPORT</p><h2>{ui('importAudioOrVideo')}</h2></div></div>
      <label className="drop-zone"><input type="file" disabled={Boolean(importProgress)} accept={importFileAccept} onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} /><strong>{ui('chooseFile')}</strong><span>{ui('importFormats')}</span></label>
      {importError && <p className="import-error" role="alert">{importError}</p>}
      {importedFile && <div className="import-result"><strong>{importedFile.name}</strong><span>{(importedFile.size / 1024 / 1024).toFixed(1)} MB · {importedFile.type || ui('unknownMediaType')}</span><p>{importedFile.name.toLowerCase().endsWith('.wav') ? ui('wavBatchHint') : ui('otherImportHint')}</p>{importProgress ? <div className="batch-progress"><span>{ui('transcribingChunk').replace('{current}', String(importProgress.current)).replace('{total}', String(importProgress.total))}</span><progress value={importProgress.current} max={importProgress.total} /><button className="danger" onClick={cancelImport}>{ui('cancelBatch')}</button></div> : <button className="primary" onClick={() => void transcribeImportedFile()}>{ui('batchTranscription')}</button>}</div>}
    </section>
  ) : (
    <SettingsView
      controller={controller}
      settingsReturnView={settingsReturnView}
      onNavigate={navigate}
      leaveRequest={leaveRequest}
      onLeaveResolved={(target) => { setLeaveRequest(null); setSettingsDirty(false); setView(target) }}
      onLeaveDismissed={() => setLeaveRequest(null)}
      onDirtyChange={setSettingsDirty}
      summaryTemplate={{ select: selectSummaryTemplate, remove: deleteSummaryTemplate }}
    />
  )

const sidebarViewGroups: Array<{ id: string; label: string; items: Array<{ id: View; label: string; icon: ReactElement }> }> = [
  { id: 'workspace', label: ui('workspace'), items: [
    { id: 'live', label: t('live'), icon: <NavigationGlyph name="live" /> },
    { id: 'history', label: t('history'), icon: <NavigationGlyph name="history" /> },
    { id: 'summary', label: ui('summary'), icon: <NavigationGlyph name="summary" /> },
    { id: 'import', label: t('import'), icon: <NavigationGlyph name="import" /> }
  ] },
  { id: 'management', label: ui('management'), items: [
    { id: 'models', label: t('models'), icon: <NavigationGlyph name="models" /> },
    { id: 'voiceprints', label: t('voiceprints'), icon: <NavigationGlyph name="voiceprints" /> },
    { id: 'settings', label: t('settings'), icon: <NavigationGlyph name="settings" /> }
  ] }
]

if (isFloatingCaptionWindow) {
    return <main className="floating-caption" aria-live="polite"><header><span>{ui('floatingCaptions')}</span><div><button className="text-button" onClick={toggleFloatingCaptionFullscreen}>{floatingCaptionFullscreen ? ui('exitFullscreen') : ui('fullscreen')}</button><button className="text-button" onClick={closeFloatingCaptions}>{ui('close')}</button></div></header><div className="floating-caption-content"><p>{floatingCaptionText}</p></div></main>
  }

return (
    <main>
      {statusToast && <div className="status-toast" role="status" aria-live="polite">{statusToast}</div>}
      <datalist id="registered-speakers">{[...new Set(voiceprints.map((voiceprint) => voiceprint.NT))].map((NT) => <option key={NT} value={NT} />)}</datalist>
      {downloadPicker && <DownloadPicker ui={ui} title={downloadPicker.kind === 'session' ? downloadPicker.entry.title : downloadPicker.title} scope={downloadPicker.kind === 'session' ? downloadPicker.scope : 'summary'} busy={downloadBusy} error={downloadError} onPick={pickDownload} onClose={() => { if (!downloadBusy) setDownloadPicker(null) }} />}
      {modelDialogOpen && <div className="transcript-modal-backdrop" role="presentation" onMouseDown={() => setModelDialogOpen(false)}><section className="transcript-modal model-dialog" role="dialog" aria-modal="true" aria-label={t('models')} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">{ui('modelManagement').toUpperCase()}</p><h2>{modelDialogCanDelete ? ui('editModel') : ui('registerModel')}</h2></div><button className="text-button" onClick={() => setModelDialogOpen(false)}>{ui('close')}</button></header><div className="model-actions"><label>{ui('modelPurpose')}<select value={modelPurpose} disabled={Boolean(editingModelId)} onChange={(event) => { const purpose = event.target.value as typeof modelPurpose; setModelPurpose(purpose); setEditingModelId(null); setModelDialogCanDelete(false); setNewModelName(''); setNewModelEndpoint(''); setNewModelId('') }}><option value="asr">{ui('speechRecognition')}</option><option value="translation">{ui('translation')}</option><option value="summary">{ui('summaryTitle')}</option><option value="diarization">{ui('speakerDiarization')}</option><option value="embedding">{ui('embedding')}</option></select></label><input value={newModelName} placeholder={ui('modelDisplayName')} onChange={(event) => setNewModelName(event.target.value)} /><input type="url" value={newModelEndpoint} placeholder={ui('endpointUrl')} onChange={(event) => setNewModelEndpoint(event.target.value)} /><input value={newModelId} placeholder={ui('modelId')} onChange={(event) => setNewModelId(event.target.value)} /><label><input type="checkbox" checked={!newModelRequiresApiKey} onChange={(event) => setNewModelRequiresApiKey(!event.target.checked)} />{ui('apiKeyNotRequired')}</label>{newModelRequiresApiKey && <input type="password" autoComplete="off" value={newModelApiKey} placeholder={ui('encryptedApiKey')} onChange={(event) => setNewModelApiKey(event.target.value)} />}{modelPurpose === 'asr' && <><label className="model-transport-toggle"><input type="checkbox" checked={newModelUsesBuiltin} onChange={(event) => setNewModelUsesBuiltin(event.target.checked)} />{ui('builtInSegmentation')}</label><div className="model-capabilities"><label>{ui('asrMode')}<select value={modelCapabilities.asrMode} onChange={(event) => setModelCapabilities((current) => ({ ...current, asrMode: event.target.value as ModelCapabilities['asrMode'] }))}><option value="non-streaming">{ui('nonStreaming')}</option><option value="streaming">{ui('streaming')}</option></select></label><label>{ui('vadSource')}<select value={modelCapabilities.vadSource} onChange={(event) => setModelCapabilities((current) => ({ ...current, vadSource: event.target.value as ModelCapabilities['vadSource'] }))}><option value="app">{ui('appVad')}</option><option value="server">{ui('serverVad')}</option></select></label><label>{ui('timestampPrecision')}<select value={modelCapabilities.timestampPrecision} onChange={(event) => setModelCapabilities((current) => ({ ...current, timestampPrecision: event.target.value as ModelCapabilities['timestampPrecision'] }))}><option value="chunk">{ui('chunkBoundary')}</option><option value="segment">{ui('segmentTimestamp')}</option><option value="word">{ui('wordTimestamp')}</option></select></label><label>{ui('supportedLanguages')}<input value={(modelCapabilities.supportedLanguages ?? []).join(', ')} placeholder="zh-TW, en-US" onChange={(event) => setModelCapabilities((current) => ({ ...current, supportedLanguages: event.target.value.split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z-]{2,20}$/.test(value)).slice(0, 12) }))} /></label><label>{ui('supportedSampleRates')}<input value={(modelCapabilities.supportedSampleRates ?? []).join(', ')} placeholder="16000, 44100, 48000" onChange={(event) => setModelCapabilities((current) => ({ ...current, supportedSampleRates: event.target.value.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 8_000 && value <= 192_000).slice(0, 12) }))} /></label></div><p className="hint">{ui('sampleRateCapabilityHint')}</p></>}<div className="model-dialog-actions"><button className="primary" onClick={saveManagedModel}>{modelDialogCanDelete ? ui('saveChanges') : ui('registerModel')}</button>{modelDialogCanDelete && <button className="danger" onClick={deleteManagedModel}>{ui('deleteModel')}</button>}</div></div></section></div>}
      <div className="app-layout">
        <aside className={historyCollapsed ? 'history-sidebar collapsed' : 'history-sidebar'} aria-label={ui('workspace')}>
          <div className="sidebar-topbar">{historyCollapsed ? <button className="sidebar-icon-button sidebar-expand" aria-label={ui('expandSidebar')} title={ui('expandSidebar')} onClick={() => setHistoryCollapsed(false)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button> : <><span className="sidebar-product-title">{productTitleImage && !titleImageFailed ? <img src={productTitleImage} alt="S2T UI" onError={() => setTitleImageFailed(true)} /> : 'S2T UI'}</span><button className="text-button history-toggle" aria-label={ui('collapseSidebar')} title={ui('collapseSidebar')} onClick={() => { setHistoryCollapsed(true); setLiveControlsOpen(false) }}>‹</button></>}</div>
          <div className="sidebar-nav-groups">{!(view === 'live' && liveControlsOpen && !historyCollapsed) && sidebarViewGroups.map((group) => { const expanded = collapsedGroups[group.id] !== true; return <div key={group.id} className="sidebar-group"><button type="button" className="sidebar-group-label" aria-expanded={expanded} aria-controls={`sidebar-group-${group.id}`} onClick={() => setCollapsedGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>{group.label}</button>{expanded && <nav id={`sidebar-group-${group.id}`} className="sidebar-nav" aria-label={group.label}>{group.items.map((item) => <TooltipButton tooltip={item.label} placement="right" key={item.id} className={view === item.id ? 'active' : ''} aria-current={view === item.id ? 'page' : undefined} aria-label={item.label} onClick={() => { if (item.id === 'settings') { if (view !== 'settings') openSettings(view) } else navigate(item.id) }}><span className="sidebar-nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true">{item.icon}</svg></span><span className="sidebar-nav-label">{item.label}</span></TooltipButton>)}</nav>}</div> })}</div>
          {view === 'live' && liveControlsOpen && !historyCollapsed && <>{sidebarSection === 'speakers' && <section id="live-sidebar-speakers" className="speaker-sidebar-editor"><SpeakerBatchRename speakerLabel={ui('speaker')} renameToLabel={ui('renameSpeakerTo')} renameActionLabel={ui('renameSpeakerBatch')} unassignedLabel={ui('unassignedSpeaker')} nameLabel={ui('speakerName')} enableDiarizationLabel={ui('enableSpeakerDiarization')} rename={renameLiveSpeaker} diarizationEnabled={settings.diarizationPreviewEnabled} setDiarizationEnabled={(enabled) => setSettings((current) => ({ ...current, diarizationPreviewEnabled: enabled }))} /></section>}
          {sidebarSection === 'history' && <div id="live-sidebar-history" className="history-sidebar-list">{sessions.length ? sessions.slice(0, 40).map((entry) => <button key={entry.id} className="history-sidebar-item" title={ui('loadRecordIntoLive').replace('{title}', entry.title)} onClick={() => void loadSessionIntoLive(entry)}><strong>{entry.title}</strong><small>{new Date(entry.createdAt).toLocaleDateString(resolveUiLanguage(settings.uiLanguage))}</small></button>) : <p>{ui('noHistory')}</p>}<button className="text-button history-all-button" onClick={() => setView('history')}>{ui('allHistory')}</button></div>}
          {sidebarSection === 'capture' && <section id="live-sidebar-capture" className="history-quick-settings"><div className="history-quick-settings-content"><label>{ui('microphone')}<select value={selectedDeviceId} onChange={(event) => selectDevice(event.target.value)} disabled={captureState === 'saving' || captureState === 'starting'}><option value="default">{ui('systemDefaultMicrophone')}</option><option value="none">{ui('notInUse')}</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label><div className="meter" aria-label={`${ui('microphoneLevel')} ${dbfsLabel(microphoneLevel)}`}><div className="meter-label"><span>{ui('microphoneLevel')}</span><strong>{dbfsLabel(microphoneLevel)}</strong></div><div className="meter-track"><div ref={microphoneMeterValueRef} className="meter-value" style={{ width: `${meterPercent(microphoneLevel)}%` }} /></div></div><label>{ui('computerAudio')}<select value={includeSystemAudio ? 'system' : 'none'} onChange={(event) => void selectSystemAudio(event.target.value === 'system')} disabled={captureState === 'saving' || captureState === 'starting'}><option value="none">{ui('notInUse')}</option><option value="system">{ui('chooseComputerAudio')}</option></select></label><div className="meter" aria-label={`${ui('computerAudioLevel')} ${dbfsLabel(systemLevel)}`}><div className="meter-label"><span>{ui('computerAudioLevel')}</span><strong>{systemStreamRef.current ? dbfsLabel(systemLevel) : ui('notConnected')}</strong></div><div className="meter-track"><div ref={systemMeterValueRef} className="meter-value" style={{ width: `${meterPercent(systemLevel)}%` }} /></div></div><label>{ui('sourceLanguage')}<select value={settings.sourceLanguage} onChange={(event) => setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="auto">{ui('autoDetect')}</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option><option value="de-DE">Deutsch</option></select></label><label><input type="checkbox" checked={settings.translationEnabled} onChange={(event) => setSettings((current) => ({ ...current, translationEnabled: event.target.checked }))} />{ui('enableTranslation')}</label><label>{ui('targetLanguage')}<select value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label><p className="quick-settings-heading">{ui('vadAndCaptions')}</p><label><input type="checkbox" checked={settings.diarizationPreviewEnabled} onChange={(event) => setSettings((current) => ({ ...current, diarizationPreviewEnabled: event.target.checked }))} />{ui('enableDiarizationPreview')}</label><label className="quick-settings-speed" title={ui('speedHint')}>{ui('responseSpeed')}{ui('labelColon')}{ui(responseSpeedKey)}<input type="range" min="0" max="2" step="1" value={responseSpeeds.indexOf(settings.responseSpeed)} aria-label={ui('responseSpeed')} aria-valuetext={ui(responseSpeedKey)} onChange={(event) => setSettings((current) => ({ ...current, responseSpeed: responseSpeeds[Number(event.target.value)] ?? 'normal' }))} /><span className="quick-settings-speed-scale" aria-hidden="true"><span>{ui('speedFast')}</span><span>{ui('speedNormal')}</span><span>{ui('speedSlow')}</span></span></label><small className="quick-settings-hint">{captureState === 'recording' || captureState === 'paused' ? ui('liveSettingsNextChunk') : ui('liveSettingsStartHint')}</small><button className="text-button" onClick={() => void refreshDevices().catch(() => setStatus(ui('refreshAudioSourcesFailed')))} disabled={captureState === 'starting' || captureState === 'saving'}>{ui('refreshAudioSources')}</button><button className="secondary" onClick={() => openSettings('live')}>{ui('fullSettings')}</button></div></section>}</>}
          <div className="sidebar-account"><span className="sidebar-account-avatar" aria-hidden="true">{user.NT.slice(0, 2).toUpperCase()}</span><div className="sidebar-account-meta"><strong title={user.NT}>{user.NT}</strong><small title={user.Department}>{user.Department}</small></div><button className="sidebar-icon-button sidebar-account-logout" aria-label={t('logout')} title={t('logout')} onClick={() => void onLogout()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></svg></button></div>
        </aside>
        <section className="workspace-content">{workspace}</section>
      </div>
    </main>
  )
}
