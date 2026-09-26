import { type SavedSession, type ModelCapabilities, type ModelProfile, type View } from '../../../shared/types'
import { dbfsLabel, meterPercent } from '../../../shared/services/audio'
import { timestamp } from '../../../shared/services/transcript'
import { modelEndpoint, textEndpoint } from '../../../shared/services/settings'
import { interfaceTranslate, translate } from '../../../shared/i18n'
import { parseGlossaryJson } from '../services/glossary-json'
import { transcriptSignature } from '../services/summary-plan'
import { addSummaryTemplate as createSummaryTemplate, removeSelectedSummaryTemplate, selectSummaryTemplate as resolveSummaryTemplate } from '../services/summary-templates'
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react'

import type { AppController } from '../hooks/useAppController'
import type { AuthUser } from '../../auth/services/auth-client'

export function AppView({ controller, user, onLogout }: { controller: AppController; user: AuthUser; onLogout: () => Promise<void> }): ReactElement {
const [menuOpen, setMenuOpen] = useState(false)
const [settingsCategory, setSettingsCategory] = useState<'asr' | 'translation' | 'summary' | 'speakers' | 'app'>('asr')
const [modelDialogOpen, setModelDialogOpen] = useState(false)
const [modelPurpose, setModelPurpose] = useState<'asr' | 'translation' | 'summary' | 'diarization'>('asr')
const [editingModelId, setEditingModelId] = useState<string | null>(null)
const [modelDialogCanDelete, setModelDialogCanDelete] = useState(false)
const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilities>({ asrMode: 'non-streaming', vadSource: 'app', timestampPrecision: 'chunk' })
const [editingSessionSegmentId, setEditingSessionSegmentId] = useState<string | null>(null)
const [newGlossaryTerm, setNewGlossaryTerm] = useState('')
const [glossarySearch, setGlossarySearch] = useState('')
const [modelSearch, setModelSearch] = useState('')
const [newSummaryTemplateName, setNewSummaryTemplateName] = useState('')
const [newSummaryTemplateContent, setNewSummaryTemplateContent] = useState('')
const [isCreatingSummaryTemplate, setIsCreatingSummaryTemplate] = useState(false)
const [copyOptions] = useState({ includeTimestamp: true, includeSpeaker: true, includeTranslation: true })
const [historyCollapsed, setHistoryCollapsed] = useState(false)
const [sidebarSection, setSidebarSection] = useState<'history' | 'settings'>('history')
const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
const sessionMenuRef = useRef<HTMLDivElement | null>(null)
const [summarySessionId, setSummarySessionId] = useState<string | null>(null)
const [settingsReturnView, setSettingsReturnView] = useState<Exclude<View, 'settings'>>('live')
const openSettings = (from: View): void => { setSettingsReturnView(from === 'settings' ? 'live' : from); setView('settings') }
const renderMarkdown = (text: string): ReactElement => <div className="markdown-summary">{text.split(/\r?\n/).map((line, index) => {
  const value = line.trim()
  if (!value) return <div className="markdown-space" key={index} />
  if (value.startsWith('### ')) return <h4 key={index}>{value.slice(4)}</h4>
  if (value.startsWith('## ')) return <h3 key={index}>{value.slice(3)}</h3>
  if (value.startsWith('# ')) return <h2 key={index}>{value.slice(2)}</h2>
  if (/^[-*]\s+/.test(value)) return <p className="markdown-item" key={index}>{value.replace(/^[-*]\s+/, '')}</p>
  return <p key={index}>{value}</p>
})}</div>
const downloadSummary = (text: string): void => { const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `s2t-summary-${new Date().toISOString().slice(0, 10)}.md`; anchor.click(); URL.revokeObjectURL(url) }
const matchesModelSearch = (...values: string[]): boolean => { const query = modelSearch.trim().toLocaleLowerCase(); return !query || values.join(' ').toLocaleLowerCase().includes(query) }
const {
isFloatingCaptionWindow,
devices,
selectedDeviceId,
includeSystemAudio,
captureState,
microphoneLevel,
systemLevel,
elapsedMs,
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
settings,
setSettings,
importedFile,
importError,
importProgress,
settingsSaved,
floatingCaptionText,
floatingCaptionFullscreen,
webCaptionPopup,
webCaptionFullscreen,
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
apiKeyStatus,
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
startCapture,
togglePause,
stopCapture,
copyTranscript,
updateTranscript,
updateSpeaker,
updateSessionSpeaker,
updateSavedTranscript,
updateSavedTranscriptTiming,
updateTranscriptTiming,
saveSettings,
addModelProfile,
updateSelectedModel,
selectTranslationProfile,
removeSelectedModel,
saveTextServiceKey,
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
deleteSession,
saveSessionToDisk,
openSavedSession,
enrollVoiceprint,
deleteVoiceprint,
startVoiceprintCapture,
stopVoiceprintCapture,
summarizeSession,
canRecord,
historyPageCount,
currentHistoryPage,
pagedSessions,
filteredSessions,
viewingSession,
visibleTranscripts,
searchedTranscripts,
clearCaptions,
loadSessionIntoLive,
renameSession
} = controller

useEffect(() => { document.documentElement.lang = settings.uiLanguage }, [settings.uiLanguage])
useEffect(() => {
  const closeOnOutsidePointer = (event: PointerEvent): void => {
    if (sessionMenuRef.current && !sessionMenuRef.current.contains(event.target as Node)) setSessionMenuId(null)
  }
  const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setSessionMenuId(null) }
  document.addEventListener('pointerdown', closeOnOutsidePointer)
  document.addEventListener('keydown', closeOnEscape)
  return () => { document.removeEventListener('pointerdown', closeOnOutsidePointer); document.removeEventListener('keydown', closeOnEscape) }
}, [])
const t = (key: Parameters<typeof translate>[1]): string => translate(settings.uiLanguage, key)
const ui = (key: Parameters<typeof interfaceTranslate>[1]): string => interfaceTranslate(settings.uiLanguage, key)
const glossaryEntries = settings.glossary.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).map((value, index) => ({ value, index }))
const replaceGlossaryEntry = (index: number, value: string): void => setSettings((current) => {
  const entries = current.glossary.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  if (value.trim()) entries[index] = value.trim(); else entries.splice(index, 1)
  return { ...current, glossary: entries.join('\n') }
})
const addGlossaryEntry = (): void => {
  const value = newGlossaryTerm.trim()
  if (!value) return
  setSettings((current) => ({ ...current, glossary: [current.glossary.trim(), value].filter(Boolean).join('\n') }))
  setNewGlossaryTerm('')
}
const importGlossaryJson = async (file: File | null): Promise<void> => {
  if (!file) return
  try {
    if (file.size > 1024 * 1024) throw new Error('術語 JSON 檔不可超過 1 MB。')
    const glossaryImport = parseGlossaryJson(await file.text())
    const glossary = glossaryImport.entries
    setSettings((current) => ({ ...current, glossary: [...current.glossary.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean), ...glossary].filter((entry, index, all) => all.indexOf(entry) === index).join('\n') }))
    setStatus(`已載入 ${glossary.length} 筆 JSON 術語${glossaryImport.invalidEntries ? `；略過 ${glossaryImport.invalidEntries} 筆無效資料` : ''}${glossaryImport.ignoredDuplicates ? `；略過 ${glossaryImport.ignoredDuplicates} 筆重複或超出上限資料` : ''}；請儲存設定。`)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'invalid-json') setStatus('JSON 格式無法讀取。')
    else if (message === 'invalid-root') setStatus('JSON 根節點必須是物件或陣列。')
    else if (message === 'empty-glossary') setStatus('找不到可用術語；請使用 {「術語」:「指定譯法」} 或 [{"term":"術語","translation":"指定譯法"}] 格式。')
    else setStatus(message || 'JSON 術語檔無法讀取。')
  }
}

const sessionTranscript = (entry: SavedSession, query: string): ReactElement => entry.segments?.length ? <>
    {entry.segments.filter((segment) => segment.status !== 'gap' && `${segment.speaker ?? ''} ${segment.sourceText} ${segment.translatedText ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((segment) => <article key={segment.id}>
      <time>{timestamp(segment.startMs)}</time>
      {editingSessionSegmentId === segment.id ? <div className="transcript-edit"><div className="timing-inputs"><label>{ui('startMilliseconds')}<input type="number" min="0" defaultValue={segment.startMs} onBlur={(event) => updateSavedTranscriptTiming(entry.id, segment.id, { startMs: Number(event.currentTarget.value) })} /></label><label>{ui('endMilliseconds')}<input type="number" min="1" defaultValue={segment.endMs} onBlur={(event) => updateSavedTranscriptTiming(entry.id, segment.id, { endMs: Number(event.currentTarget.value) })} /></label></div><label className="speaker-row"><span>{ui('speaker')}</span><input aria-label={ui('speakerName')} value={segment.speaker ?? ''} placeholder={ui('unassignedSpeaker')} onChange={(event) => updateSessionSpeaker(entry.id, segment.id, event.target.value)} /></label><textarea defaultValue={segment.sourceText} aria-label={ui('sourceText')} onBlur={(event) => updateSavedTranscript(entry.id, segment.id, { sourceText: event.currentTarget.value })} /><textarea defaultValue={segment.translatedText ?? ''} aria-label={ui('translation')} placeholder={ui('optionalTranslation')} onBlur={(event) => updateSavedTranscript(entry.id, segment.id, { translatedText: event.currentTarget.value })} /><button className="text-button" onClick={() => setEditingSessionSegmentId(null)}>{ui('doneEditing')}</button></div> : <><label className="speaker-row"><span>{ui('speaker')}</span><input aria-label={ui('speakerName')} value={segment.speaker ?? ''} placeholder={ui('unassignedSpeaker')} onChange={(event) => updateSessionSpeaker(entry.id, segment.id, event.target.value)} /></label><p>{segment.sourceText}</p>{segment.translatedText && <p className="translation">{segment.translatedText}</p>}<button className="edit-button" onClick={() => setEditingSessionSegmentId(segment.id)}>{ui('edit')}</button>{segmentRerecordingId === segment.id ? <button className="text-button" onClick={() => void stopSegmentRerecord()}>{ui('endRerecording')}</button> : <button className="text-button" disabled={Boolean(segmentRerecordingId)} onClick={() => void startSegmentRerecord(entry, segment)}>{ui('rerecordSegment')}</button>}<label className="text-button">{ui('rerecordWav')}<input hidden type="file" accept="audio/wav,.wav" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void replaceSessionSegmentAudio(entry, segment, file) }} /></label></>}
    </article>)}
  </> : <pre>{entry.transcript || ui('noCaptionsForRecord')}</pre>

const liveWorkspace = (
    <div className="live-workspace">
      <section className="caption-window" style={{ '--caption-scale': captionScale } as CSSProperties}>
        <div className="live-caption-heading"><div><p className="eyebrow">LIVE CAPTIONS</p><h2>{t('live')}</h2></div><div className="caption-actions"><span>{visibleTranscripts.length} {ui('segments')}</span><input className="caption-search" aria-label={ui('searchCaptions')} value={transcriptSearch} placeholder={ui('searchCaptions')} onChange={(event) => setTranscriptSearch(event.target.value)} /><button className="text-button caption-size-button" aria-label={ui('decreaseCaptionSize')} title={ui('decreaseCaptionSize')} disabled={captionScale <= .8} onClick={() => setCaptionScale((scale) => Math.max(.8, Number((scale - .1).toFixed(1))))}>小A</button><button className="text-button caption-size-button" aria-label={ui('increaseCaptionSize')} title={ui('increaseCaptionSize')} disabled={captionScale >= 1.6} onClick={() => setCaptionScale((scale) => Math.min(1.6, Number((scale + .1).toFixed(1))))}>大A</button><button className="text-button" onClick={cancelPendingTranslations}>{ui('cancelTranslation')}</button><button className="text-button" disabled={!visibleTranscripts.length} onClick={clearCaptions}>{ui('clearScreen')}</button>{!followingCaptions && <button className="text-button" onClick={() => setFollowingCaptions(true)}>{ui('backToLatest')}</button>}</div></div>
        <section ref={transcriptContainerRef} className="transcript" aria-live="polite" title={ui('openCaptionPopup')} onClick={(event) => { const target = event.target as HTMLElement; if (!target.closest('button, select, textarea, input')) openFloatingCaptions() }} onScroll={(event) => { const element = event.currentTarget; setFollowingCaptions(element.scrollHeight - element.scrollTop - element.clientHeight < 48) }}>
        {visibleTranscripts.length === 0 ? (
          <div className="empty"><h2>{ui('waitingForSpeech')}</h2><p>{ui('waitingForSpeechHint')}</p></div>
        ) : <>{searchedTranscripts.map((entry) => (
          <article key={entry.id} className={entry.status}>
            <time>{timestamp(entry.startMs)}</time>
            {editingTranscriptId === entry.id ? <div className="transcript-edit"><div className="timing-inputs"><label>{ui('startMilliseconds')}<input type="number" min="0" defaultValue={entry.startMs} onBlur={(event) => updateTranscriptTiming(entry.id, Number(event.currentTarget.value), entry.endMs)} /></label><label>{ui('endMilliseconds')}<input type="number" min="1" defaultValue={entry.endMs} onBlur={(event) => updateTranscriptTiming(entry.id, entry.startMs, Number(event.currentTarget.value))} /></label></div><textarea value={entry.sourceText} onChange={(event) => updateTranscript(entry.id, event.target.value, entry.translatedText ?? '')} /><textarea value={entry.translatedText ?? ''} placeholder={ui('optionalTranslation')} onChange={(event) => updateTranscript(entry.id, entry.sourceText, event.target.value)} /><button className="text-button" onClick={() => setEditingTranscriptId(null)}>{ui('doneEditing')}</button></div> : <><div className="speaker-row"><input aria-label={ui('speakerName')} value={entry.speaker ?? ''} placeholder={ui('unassignedSpeaker')} onChange={(event) => updateSpeaker(entry.id, event.target.value)} /></div><p>{entry.sourceText}</p>{entry.translatedText && <p className="translation">{entry.translatedText}</p>}{entry.translationStatus === 'failed' && <button className="text-button translation-retry" onClick={() => { setTranscripts((current) => current.map((currentEntry) => currentEntry.id === entry.id ? { ...currentEntry, translationStatus: undefined } : currentEntry)); void requestTranslation({ ...entry, translationStatus: undefined }) }}>{ui('retryTranslation')}</button>}<button className="edit-button" onClick={() => setEditingTranscriptId(entry.id)}>{ui('edit')}</button></>}
          {settings.translationLoadStrategy === 'manual' && entry.status === 'final' && !entry.translatedText && <button className="text-button translation-retry" onClick={() => void requestTranslation(entry)}>{ui('translateSegment')}</button>}</article>
        ))}</>}
      </section>

      </section>

      {webCaptionPopup && <div ref={webCaptionPopupRef} className="transcript-modal-backdrop web-caption-popup" role="presentation" onMouseDown={closeWebCaptionPopup}><section className="transcript-modal" role="dialog" aria-modal="true" aria-label={ui('captionPopup')} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">LIVE CAPTIONS</p><h2>{t('live')}</h2></div><div><button className="text-button" onClick={toggleWebCaptionFullscreen}>{webCaptionFullscreen ? ui('exitFullscreen') : ui('fullscreen')}</button><button className="text-button" onClick={closeWebCaptionPopup}>{ui('close')}</button></div></header><div className="session-transcript">{visibleTranscripts.length ? visibleTranscripts.slice(-8).map((entry) => <article key={entry.id}><time>{timestamp(entry.startMs)}</time><p>{entry.sourceText}</p>{entry.translatedText && <p className="translation">{entry.translatedText}</p>}</article>) : <p>{ui('waitingForCaptions')}</p>}</div></section></div>}
      <section className="capture-panel capture-controls-only" aria-label={ui('captureControls')}>
        <div className="source-capture-row"><div className="capture-controls">{canRecord ? <button className="primary" disabled={selectedDeviceId === 'none' && !includeSystemAudio} onClick={() => void startCapture()}>{ui('startRecording')}</button> : captureState === 'starting' || captureState === 'saving' ? <button className="secondary" disabled>{captureState === 'starting' ? ui('connecting') : ui('saving')}</button> : <><button className="secondary" onClick={() => void togglePause()}>{captureState === 'paused' ? ui('resumeRecording') : ui('pauseRecording')}</button><button className="danger" onClick={() => void stopCapture()}>{ui('stopRecording')}</button></>}</div><div className="timer">{timestamp(elapsedMs)}</div></div>
      </section>
      {(summaryStatus || summaryText) && <section className="summary-panel"><div className="meter-label"><span>{ui('meetingNotes')}</span><strong>{summaryStatus}</strong></div>{summaryText && <><div className="summary-actions"><button className="text-button" onClick={() => void navigator.clipboard.writeText(summaryText)}>{ui('copy')}</button><button className="text-button" onClick={() => downloadSummary(summaryText)}>↓ {ui('exportMarkdown')}</button></div>{renderMarkdown(summaryText)}</>}</section>}

    </div>
  )

const openModelManager = (purpose: 'asr' | 'translation' | 'summary' | 'diarization', id: string | null = null): void => {
  setModelPurpose(purpose); setEditingModelId(id)
  setModelDialogCanDelete(Boolean(id) || (purpose === 'summary' && Boolean(settings.summaryModel)) || (purpose === 'diarization' && Boolean(settings.diarizationModel)))
  if (purpose === 'asr') { const profile = settings.modelProfiles.find((item) => item.id === id); setNewModelName(profile?.name ?? ''); setNewModelEndpoint(profile?.endpoint ?? ''); setNewModelId(profile?.model ?? ''); setNewModelRequiresApiKey(profile?.requiresApiKey !== false); setNewModelUsesBuiltin(profile?.kind === 'openai-http'); setModelCapabilities(profile?.capabilities ?? { asrMode: 'non-streaming', vadSource: 'app', timestampPrecision: 'chunk' }) }
  if (purpose === 'translation') { const profile = settings.translationProfiles.find((item) => item.id === id); setNewModelName(profile?.name ?? ''); setNewModelEndpoint(profile?.endpoint ?? ''); setNewModelId(profile?.model ?? '') }
  if (purpose === 'summary') { setNewModelName('會議摘要'); setNewModelEndpoint(settings.summaryEndpoint); setNewModelId(settings.summaryModel) }
  if (purpose === 'diarization') { setNewModelName('講者分離'); setNewModelEndpoint(settings.diarizationEndpoint); setNewModelId(settings.diarizationModel) }
  setNewModelApiKey(''); setModelDialogOpen(true)
}
const saveManagedModel = (): void => {
  const name = newModelName.trim(); const endpoint = newModelEndpoint.trim(); const model = newModelId.trim()
  if (!name || !endpoint || !model) { setStatus('請填寫模型名稱、endpoint 與 model ID。'); return }
  if (modelPurpose === 'asr' && !editingModelId) { void addModelProfile(modelCapabilities); setModelDialogOpen(false); return }
  setSettings((current) => {
    if (modelPurpose === 'asr') return { ...current, modelProfiles: current.modelProfiles.map((profile) => profile.id === editingModelId ? { ...profile, name, endpoint, model, kind: newModelUsesBuiltin ? 'openai-http' : 'websocket', requiresApiKey: newModelRequiresApiKey, capabilities: modelCapabilities } : profile) }
    if (modelPurpose === 'translation') { const id = editingModelId ?? crypto.randomUUID(); const profile = { id, name, endpoint, model }; const profiles = current.translationProfiles.some((item) => item.id === id) ? current.translationProfiles.map((item) => item.id === id ? profile : item) : [...current.translationProfiles, profile]; return { ...current, translationProfiles: profiles, selectedTranslationModelId: id, translationEndpoint: endpoint, translationModel: model } }
    return modelPurpose === 'summary' ? { ...current, summaryEndpoint: endpoint, summaryModel: model } : { ...current, diarizationEndpoint: endpoint, diarizationModel: model }
  })
  if (newModelApiKey.trim() && modelPurpose !== 'asr') void saveTextServiceKey(modelPurpose, newModelApiKey, () => setNewModelApiKey(''))
  if (newModelApiKey.trim() && modelPurpose === 'asr' && editingModelId && window.s2t) {
    void window.s2t.saveModelApiKey(editingModelId, newModelApiKey.trim()).then(() => setNewModelApiKey('')).catch(() => setStatus('模型設定已更新，但 API key 保存失敗。'))
  }
  setModelDialogOpen(false); setStatus('模型設定已更新。')
}
const deleteManagedModel = (): void => {
  if (!editingModelId && !(modelPurpose === 'summary' && settings.summaryModel) && !(modelPurpose === 'diarization' && settings.diarizationModel)) return
  setSettings((current) => {
    if (modelPurpose === 'asr') return { ...current, modelProfiles: current.modelProfiles.filter((profile) => profile.id !== editingModelId), selectedModelId: current.selectedModelId === editingModelId ? 'none' : current.selectedModelId }
    if (modelPurpose === 'translation') { const profiles = current.translationProfiles.filter((profile) => profile.id !== editingModelId); return { ...current, translationProfiles: profiles, selectedTranslationModelId: current.selectedTranslationModelId === editingModelId ? 'none' : current.selectedTranslationModelId, translationEndpoint: current.selectedTranslationModelId === editingModelId ? '' : current.translationEndpoint, translationModel: current.selectedTranslationModelId === editingModelId ? '' : current.translationModel } }
    return modelPurpose === 'summary' ? { ...current, summaryEndpoint: '', summaryModel: '' } : { ...current, diarizationEndpoint: '', diarizationModel: '' }
  })
  setModelDialogOpen(false); setStatus('模型已刪除。')
}
const selectSummaryTemplate = (id: string): void => setSettings((current) => {
  const selected = resolveSummaryTemplate(current.summaryTemplates, id)
  return selected ? { ...current, ...selected } : current
})
const addSummaryTemplate = (): void => {
  try {
    setSettings((current) => ({ ...current, ...createSummaryTemplate(current.summaryTemplates, crypto.randomUUID(), newSummaryTemplateName, newSummaryTemplateContent) }))
  } catch { setStatus('請輸入模板名稱。'); return }
  setNewSummaryTemplateName(''); setNewSummaryTemplateContent(''); setIsCreatingSummaryTemplate(false)
}
const deleteSummaryTemplate = (): void => setSettings((current) => {
  try { return { ...current, ...removeSelectedSummaryTemplate(current.summaryTemplates, current.selectedSummaryTemplateId) } }
  catch { setStatus('請至少保留一個摘要模板。'); return current }
})
const setDenoiseEnabled = (enabled: boolean): void => {
  setSettings((current) => ({ ...current, denoiseEnabled: enabled }))
  if (captureState === 'recording' || captureState === 'paused') setStatus('降噪偏好已保存；需切換麥克風或下次開始收音才會建立新的音源 stream。')
}
const summarySession = sessions.find((entry) => entry.id === summarySessionId) ?? null
const summaryIsOutdated = Boolean(summarySession?.summary && (!summarySession.summarySourceSignature || summarySession.summarySourceSignature !== transcriptSignature(summarySession.transcript)))
const summaryWorkspace = <section className="page-panel summary-workspace">
  <div className="page-title"><div><p className="eyebrow">SUMMARY</p><h2>{ui('summaryTitle')}</h2></div></div>
  <div className="summary-workspace-grid">
    <section className="summary-setup">
      <label>{ui('selectRecord')}<select value={summarySessionId ?? ''} onChange={(event) => setSummarySessionId(event.target.value || null)}><option value="">{ui('chooseHistoryRecord')}</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {new Date(entry.createdAt).toLocaleDateString(settings.uiLanguage)}</option>)}</select></label>
      <label>{ui('summaryTemplate')}<select value={isCreatingSummaryTemplate ? 'custom' : settings.selectedSummaryTemplateId} onChange={(event) => { if (event.target.value === 'custom') { setIsCreatingSummaryTemplate(true); setNewSummaryTemplateName(''); setNewSummaryTemplateContent(['# ' + ui('summaryTitle'), '', '## ' + ui('keyPoints'), '- ', '', '## ' + ui('decisions'), '- ', '', '## ' + ui('actionItems'), '- '].join(String.fromCharCode(10))) } else { setIsCreatingSummaryTemplate(false); selectSummaryTemplate(event.target.value) } }}><option value="custom">{ui('customTemplate')}</option>{settings.summaryTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
      {isCreatingSummaryTemplate && <div className="summary-custom-template"><label>{ui('templateName')}<input value={newSummaryTemplateName} placeholder={ui('templateNamePlaceholder')} onChange={(event) => setNewSummaryTemplateName(event.target.value)} /></label><label>{ui('markdownTemplate')}<textarea value={newSummaryTemplateContent} onChange={(event) => setNewSummaryTemplateContent(event.target.value)} /></label><button className="secondary" onClick={addSummaryTemplate}>{ui('saveCustomTemplate')}</button></div>}
      <label>{ui('outputLanguage')}<select value={settings.summaryOutputLanguage} onChange={(event) => setSettings((current) => ({ ...current, summaryOutputLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label>
      <label className="summary-translation-option"><input type="checkbox" checked={settings.summaryIncludeTranslation} onChange={(event) => setSettings((current) => ({ ...current, summaryIncludeTranslation: event.target.checked }))} /> {ui('includeTranslation')}</label>
      <div className="summary-template-preview"><span>{ui('currentTemplate')}</span><pre>{isCreatingSummaryTemplate ? newSummaryTemplateContent : settings.summaryTemplate}</pre></div>
      <button className="secondary" onClick={() => openSettings('summary')}>{ui('manageTemplates')}</button>
      <button className="primary" disabled={!summarySession?.transcript.trim()} onClick={() => summarySession && void summarizeSession(summarySession)}>{summarySession?.summary === '正在產生摘要…' ? ui('generating') : summarySession?.summary ? ui('regenerateSummary') : ui('generateSummary')}</button>
    </section>
    <section className="summary-result"><div className="summary-result-heading"><div><p className="eyebrow">{ui('formattedOutput').toUpperCase()}</p><h3>{summarySession ? summarySession.title : ui('notSelected')}</h3>{summaryIsOutdated && <p className="summary-stale">{ui('summaryOutdated')}</p>}</div>{summarySession?.summary && summarySession.summary !== '正在產生摘要…' && <div className="summary-actions"><button className="text-button" onClick={() => void navigator.clipboard.writeText(summarySession.summary!)}>▣ {ui('copy')}</button><button className="text-button" onClick={() => downloadSummary(summarySession.summary!)}>↓ {ui('exportMarkdown')}</button></div>}</div>{summarySession?.summary === '正在產生摘要…' ? <div className="empty compact"><h2>{ui('summaryGeneratingTitle')}</h2><p>{ui('summaryGeneratingHint')}</p></div> : summarySession?.summary ? renderMarkdown(summarySession.summary) : <div className="empty compact"><h2>{ui('preparingSummary')}</h2><p>{ui('summaryReadyHint')}</p></div>}</section>
  </div>
</section>
const workspace = view === 'live' ? liveWorkspace : view === 'history' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">HISTORY</p><h2>{ui('recordingsAndTranscripts')}</h2></div><div className="history-title-actions">{window.s2t && <button className="secondary" onClick={() => void openSavedSession()}>{ui('openSavedSession')}</button>}<span>{filteredSessions.length} {ui('records')}</span></div></div>
      {sessions.length === 0 ? <div className="empty compact"><h2>{ui('noRecords')}</h2><p>{ui('noRecordsHint')}</p></div> : <>
        <div className="history-pagination"><label>{ui('searchRecords')}<input value={historySearch} placeholder={ui('recordSearchPlaceholder')} onChange={(event) => { setHistorySearch(event.target.value); setHistoryPage(1) }} /></label><label>{ui('sort')}<select value={historySort} onChange={(event) => { setHistorySort(event.target.value as 'title' | 'createdAt' | 'durationMs'); setHistoryPage(1) }}><option value="createdAt">{ui('time')}</option><option value="title">{ui('title')}</option><option value="durationMs">{ui('duration')}</option></select></label><button className="text-button" onClick={() => setHistorySortDirection((current) => current === 'asc' ? 'desc' : 'asc')}>{historySortDirection === 'asc' ? ui('ascending') : ui('descending')}</button><label>{ui('perPage')}<select value={historyPageSize} onChange={(event) => { setHistoryPageSize(Number(event.target.value)); setHistoryPage(1) }}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label><span>{currentHistoryPage}／{historyPageCount}</span><button className="text-button" disabled={currentHistoryPage === 1} onClick={() => setHistoryPage((current) => Math.max(1, current - 1))}>{ui('previousPage')}</button><button className="text-button" disabled={currentHistoryPage === historyPageCount} onClick={() => setHistoryPage((current) => Math.min(historyPageCount, current + 1))}>{ui('nextPage')}</button></div>
        <div className="session-list">{pagedSessions.map((entry) => <article key={entry.id} className="session-item">
          <div className="session-details">{renamingSessionId === entry.id ? <form className="session-rename" onSubmit={(event) => { event.preventDefault(); renameSession(entry.id) }}><input autoFocus aria-label={ui('recordTitle')} maxLength={200} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => renameSession(entry.id)} onKeyDown={(event) => { if (event.key === 'Escape') { setTitleDraft(entry.title); setRenamingSessionId(null) } }} /></form> : <button className="session-title" title={ui('editRecordTitle')} onClick={() => { setRenamingSessionId(entry.id); setTitleDraft(entry.title) }}>{entry.title}</button>}<p>{new Date(entry.createdAt).toLocaleString(settings.uiLanguage)} · {timestamp(entry.durationMs)} · {entry.source}{entry.audioUnavailable ? ' · ' + ui('audioNotSavedRecoveryDownloaded') : entry.savedToDisk ? ' · ' + ui('saved') : ' · ' + ui('notSaved')}</p>{entry.audioVersions && entry.audioVersions.length > 1 && <label className="session-audio-version">{ui('audioVersions')}<select value={entry.activeAudioVersionId || entry.audioVersions[0].id} onChange={(event) => selectAudioVersion(entry.id, event.target.value)}>{entry.audioVersions.map((version) => <option key={version.id} value={version.id}>{version.label} · {new Date(version.createdAt).toLocaleString(settings.uiLanguage)}</option>)}</select></label>}{entry.summary && <><div className="session-summary">{entry.summarySourceSignature && entry.summarySourceSignature !== transcriptSignature(entry.transcript) && <p className="summary-stale">逐字稿已更新，請重新產生摘要。</p>}{renderMarkdown(entry.summary)}</div><div className="session-summary-actions"><button className="text-button" onClick={() => void navigator.clipboard.writeText(entry.summary!)}>{ui('copySummary')}</button><button className="text-button" onClick={() => downloadSummary(entry.summary!)}>{ui('downloadMarkdown')}</button></div></>}{playingSessionId === entry.id && playbackUrl && <audio controls autoPlay src={playbackUrl}>{ui('audioPlaybackUnsupported')}</audio>}</div>
          <div className="session-actions"><button className="session-more-button" aria-label={`${entry.title} 的更多操作`} aria-expanded={sessionMenuId === entry.id} onClick={() => setSessionMenuId((current) => current === entry.id ? null : entry.id)}>•••</button>{sessionMenuId === entry.id && <div ref={sessionMenuRef} className="session-action-menu" role="menu"><button role="menuitem" onClick={() => { setViewingSessionId(entry.id); setSessionMenuId(null) }}><span>▤</span>{ui('viewCaptions')}</button>{!entry.savedToDisk && <button role="menuitem" onClick={() => { void saveSessionToDisk(entry); setSessionMenuId(null) }}><span>↓</span>{ui('saveRecord')}</button>}<button role="menuitem" disabled={captureState !== 'idle'} onClick={() => { void continueSession(entry); setSessionMenuId(null) }}><span>↗</span>{ui('continueRecording')}</button><button role="menuitem" onClick={() => { setSummarySessionId(entry.id); setView('summary'); setSessionMenuId(null) }}><span>☷</span>{ui('generateMeetingSummary')}</button><button role="menuitem" onClick={() => { void diarizeSession(entry); setSessionMenuId(null) }}><span>◉</span>{ui('identifySpeakers')}</button><button role="menuitem" onClick={() => { void playSession(entry); setSessionMenuId(null) }}><span>▶</span>{ui('playRecording')}</button><button role="menuitem" onClick={() => { void downloadSessionAudio(entry); setSessionMenuId(null) }}><span>↓</span>{ui('downloadWav')}</button><button role="menuitem" onClick={() => { exportSavedTranscript(entry, 'vtt'); setSessionMenuId(null) }}><span>↓</span>{ui('downloadVtt')}</button><button role="menuitem" onClick={() => { void copyTranscript(entry.segments, copyOptions); setSessionMenuId(null) }}><span>▣</span>{ui('copyTranscript')}</button><button className="danger" role="menuitem" onClick={() => { void deleteSession(entry); setSessionMenuId(null) }}><span>⌫</span>{ui('deleteRecord')}</button></div>}</div>
        </article>)}</div>
      </>}
      {viewingSession && <div className="transcript-modal-backdrop" role="presentation" onMouseDown={() => setViewingSessionId(null)}><section className="transcript-modal" role="dialog" aria-modal="true" aria-label={`${viewingSession.title} 逐字稿`} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">TRANSCRIPT</p><h2>{viewingSession.title}</h2></div><button className="text-button" onClick={() => { setViewingSessionId(null); setSessionTranscriptSearch('') }}>關閉</button></header><div className="transcript-tools"><input aria-label={ui('searchThisRecord')} value={sessionTranscriptSearch} placeholder={ui('searchTranscriptPlaceholder')} onChange={(event) => setSessionTranscriptSearch(event.target.value)} /></div><div className="session-transcript">{sessionTranscript(viewingSession, sessionTranscriptSearch)}</div></section></div>}
    </section>
  ) : view === 'summary' ? summaryWorkspace : view === 'models' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">MODELS</p><h2>{t('models')}</h2></div><div className="page-title-actions"><button className="primary" onClick={() => openModelManager('asr')}>{ui('registerModel')}</button></div></div>
      <nav className="model-filter" aria-label={ui('modelCategory')}>{(['all', 'asr', 'translation', 'summary', 'diarization'] as const).map((filter) => { const counts = { asr: settings.modelProfiles.filter((profile) => profile.id !== 'none').length, translation: settings.translationProfiles.length, summary: settings.summaryModel ? 1 : 0, diarization: settings.diarizationModel ? 1 : 0 }; const count = filter === 'all' ? counts.asr + counts.translation + counts.summary + counts.diarization : counts[filter]; const label = { all: ui('all'), asr: 'ASR', translation: ui('translation'), summary: ui('summary'), diarization: ui('speakerDiarization') }[filter]; return <button key={filter} className={modelFilter === filter ? 'nav-active' : ''} onClick={() => setModelFilter(filter)}>{label} <span className="model-filter-count">{count}</span></button> })}</nav>
      <div className="model-search"><input aria-label={ui('searchModels')} value={modelSearch} placeholder={ui('searchModelsPlaceholder')} onChange={(event) => setModelSearch(event.target.value)} /></div>
      <div className="model-list">
        {(modelFilter === 'all' || modelFilter === 'asr') && settings.modelProfiles.filter((profile) => profile.id !== 'none' && matchesModelSearch(profile.name, profile.model, profile.endpoint)).map((profile) => <button className="model-list-item model-asr" key={profile.id} onClick={() => openModelManager('asr', profile.id)}><div><strong>{profile.name}</strong><p>ASR · {profile.kind === 'openai-http' ? 'OpenAI Speech-to-Text / 分段 HTTP' : 'Realtime WebSocket'} · {profile.model}</p><code>{modelEndpoint(profile.endpoint, profile.kind)}</code></div></button>)}
        {(modelFilter === 'all' || modelFilter === 'translation') && settings.translationProfiles.filter((profile) => matchesModelSearch(profile.name, profile.model, profile.endpoint)).map((profile) => <button className="model-list-item model-translation" key={profile.id} onClick={() => openModelManager('translation', profile.id)}><div><strong>{profile.name}</strong><p>翻譯 · OpenAI Chat Completions · {profile.model}</p><code>{textEndpoint(profile.endpoint)}</code></div></button>)}
        {(modelFilter === 'all' || modelFilter === 'summary') && settings.summaryModel && matchesModelSearch(settings.summaryModel, settings.summaryEndpoint) && <button className="model-list-item model-summary" onClick={() => openModelManager('summary')}><div><strong>{settings.summaryModel}</strong><p>摘要 · OpenAI Chat Completions</p><code>{textEndpoint(settings.summaryEndpoint)}</code></div></button>}
        {(modelFilter === 'all' || modelFilter === 'diarization') && settings.diarizationModel && matchesModelSearch(settings.diarizationModel, settings.diarizationEndpoint) && <button className="model-list-item model-diarization" onClick={() => openModelManager('diarization')}><div><strong>{settings.diarizationModel}</strong><p>講者分離</p><code>{settings.diarizationEndpoint}</code></div></button>}
        {settings.modelProfiles.every((profile) => profile.id === 'none') && !settings.translationProfiles.length && !settings.diarizationModel && !settings.summaryModel && <div className="empty compact"><h2>{ui('noConfiguredModels')}</h2><p>{ui('noConfiguredModelsHint')}</p></div>}
      </div>
    </section>
  ) : view === 'voiceprints' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">VOICEPRINTS</p><h2>{t('voiceprints')}</h2></div></div>
      <div className="voiceprint-page"><section className="voiceprint-enroll"><div><p className="eyebrow">ENROLLMENT</p><h3>{ui('enrollMyVoiceprint')}</h3><p>{ui('voiceprintHint')}</p></div><div className="voiceprint-capture"><button className={voiceprintCaptureState === 'recording' ? 'voiceprint-mic recording' : 'voiceprint-mic'} aria-label={voiceprintCaptureState === 'recording' ? ui('endVoiceprintRecording') : ui('startVoiceprintRecording')} disabled={voiceprintCaptureState !== 'recording' && captureState !== 'idle'} onClick={() => void (voiceprintCaptureState === 'recording' ? stopVoiceprintCapture() : startVoiceprintCapture())}>🎙</button><div className="voiceprint-meter"><div><span>{voiceprintCaptureState === 'recording' ? ui('recordingVoiceprint') : ui('microphoneReady')}</span><strong>{dbfsLabel(voiceprintLevel)}</strong></div><div className="meter-track"><div className="meter-value" style={{ width: `${meterPercent(voiceprintLevel)}%` }} /></div><small>{voiceprintCaptureState === 'recording' ? ui('endVoiceprintRecording') : ui('startVoiceprintRecording')}</small></div></div><div className="voiceprint-divider"><span>or</span></div><label className="voiceprint-upload"><input type="file" accept="audio/wav,.wav" onChange={(event) => setVoiceprintFile(event.target.files?.[0] ?? null)} /><span>{ui('uploadWavSample')}</span><small>PCM16 WAV · 1 s minimum</small></label><label className="form-field"><span>{ui('voiceprintScope')}</span><select value={voiceprintSharingScope || 'private'} onChange={(event) => { const scope = event.target.value as 'private' | 'department' | 'organization'; setVoiceprintSharingScope(scope); if (scope === 'private') setVoiceprintSharingConsent(false) }}><option value="private">{ui('privateScope')}</option><option value="department">{ui('departmentScope')}</option><option value="organization">{ui('organizationScope')}</option></select><small>{ui('privateScope')}</small></label>{voiceprintSharingScope !== 'private' && <label className="form-field"><span><input type="checkbox" checked={voiceprintSharingConsent} onChange={(event) => setVoiceprintSharingConsent(event.target.checked)} /> {ui('sharingConsent')}</span></label>}<div className="voiceprint-ready"><span>{voiceprintFile ? `✓ ${voiceprintFile.name}` : ui('uploadWavSample')}</span><button className="primary" disabled={!voiceprintFile || (voiceprintSharingScope !== 'private' && !voiceprintSharingConsent)} onClick={() => void enrollVoiceprint()}>{ui('registerVoiceprint')}</button></div></section><section className="voiceprint-library"><div><p className="eyebrow">REGISTERED</p><h3>{ui('registeredVoiceprints')} <span>{voiceprints.length}</span></h3></div>{voiceprints.length ? <div className="voiceprint-list">{voiceprints.map((voiceprint) => <article key={voiceprint.id}><div className="voiceprint-avatar">{voiceprint.NT.slice(0, 1).toUpperCase()}</div><div><strong>{voiceprint.NT}</strong><p>{voiceprint.Department} · {new Date(voiceprint.createdAt).toLocaleString(settings.uiLanguage)}</p><small>{voiceprint.embeddingModel ? `${voiceprint.embeddingModel} · ${voiceprint.embeddingVersion || '—'} · ${voiceprint.sharingScope === 'organization' ? ui('organizationScope') : voiceprint.sharingScope === 'department' ? ui('departmentScope') : ui('privateScope')}` : '—'}</small></div><button className="text-button danger" onClick={() => void deleteVoiceprint(voiceprint.id)}>{ui('remove')}</button></article>)}</div> : <div className="voiceprint-empty">{ui('noVoiceprints')}</div>}</section></div>
    </section>
  ) : view === 'import' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">IMPORT</p><h2>{ui('importAudioOrVideo')}</h2></div></div>
      <label className="drop-zone"><input type="file" disabled={Boolean(importProgress)} accept=".wav,.mp3,.m4a,.aac,.ogg,.webm,.flac,.mp4,.mov" onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} /><strong>{ui('chooseFile')}</strong><span>{ui('importFormats')}</span></label>
      {importError && <p className="import-error" role="alert">{importError}</p>}
      {importedFile && <div className="import-result"><strong>{importedFile.name}</strong><span>{(importedFile.size / 1024 / 1024).toFixed(1)} MB · {importedFile.type || '未知格式'}</span><p>{importedFile.name.toLowerCase().endsWith('.wav') ? ui('wavBatchHint') : ui('otherImportHint')}</p>{importProgress ? <div className="batch-progress"><span>{ui('transcribingChunk').replace('{current}', String(importProgress.current)).replace('{total}', String(importProgress.total))}</span><progress value={importProgress.current} max={importProgress.total} /><button className="danger" onClick={cancelImport}>{ui('cancelBatch')}</button></div> : <button className="primary" onClick={() => void transcribeImportedFile()}>{ui('batchTranscription')}</button>}</div>}
    </section>
  ) : (
    <section className="page-panel settings-panel">
      <div className="page-title"><div><p className="eyebrow">SETTINGS</p><h2>{ui('settingsTitle')}</h2></div></div>
      <nav className="settings-category-nav" aria-label={ui('settingsTitle')}>{([{ id: 'asr', label: ui('transcriptionVad') }, { id: 'translation', label: ui('translationGlossary') }, { id: 'summary', label: ui('summaryTemplates') }, { id: 'app', label: ui('application') }] as const).map((category) => <button key={category.id} className={settingsCategory === category.id ? 'nav-active' : ''} onClick={() => setSettingsCategory(category.id)}>{category.label}</button>)}</nav>
      {settingsCategory === 'translation' && <><label>{ui('sourceLanguage')}<select value={settings.sourceLanguage} onChange={(event) => setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="auto">{ui('autoDetect')}</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option><option value="de-DE">Deutsch</option></select></label>
      <label>{ui('targetLanguage')}<select value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label></>}
      {settingsCategory === 'asr' && <><div className="model-settings">
        <p className="eyebrow">{ui('asrSpeechModel')}</p>
        <label>{ui('currentModel')}<select disabled={captureState !== 'idle'} value={settings.selectedModelId} onChange={(event) => setSettings((current) => ({ ...current, selectedModelId: event.target.value }))}>{settings.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <p className="hint">{captureState === 'idle' ? ui('asrModelReadyHint') : ui('asrModelLockedHint')}</p>
        <label>{ui('modelName')}<input value={selectedModel.name} disabled={selectedModel.id === 'none'} onChange={(event) => updateSelectedModel({ name: event.target.value })} /></label>
        <label className="system-audio-option"><input type="checkbox" disabled={selectedModel.id === 'none'} checked={selectedModel.kind === 'openai-http'} onChange={(event) => {
          const kind: ModelProfile['kind'] = event.target.checked ? 'openai-http' : 'websocket'
          updateSelectedModel({ kind, endpoint: modelEndpoint(selectedModel.endpoint, kind) })
        }} /><span><strong>{ui('builtInSegmentationHint')}</strong>{selectedModel.kind === 'openai-http' ? '適用 Breeze-ASR-25：WAV 分段送到 /v1/audio/transcriptions。' : '未勾選：使用自建 Realtime gateway，預設 /v1/realtime。'}</span></label>
        <p className="hint model-api-kind">{selectedModel.kind === 'openai-http' ? 'OpenAI Speech-to-Text：multipart/form-data → /v1/audio/transcriptions（0.8–1.5 秒音訊片段）' : 'Realtime WebSocket：本 App 使用 docs/MODEL_ADAPTER.md 的自建 gateway 協定。'}</p>
        <div className="capability-fields">
          <label>{ui('asrMode')}<select disabled={selectedModel.id === 'none'} value={selectedModel.capabilities.asrMode} onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, asrMode: event.target.value as ModelCapabilities['asrMode'] } })}><option value="non-streaming">Non-streaming（分段）</option><option value="streaming">Streaming（原生串流）</option></select></label>
          <label>{ui('vadSource')}<select disabled={selectedModel.id === 'none'} value={selectedModel.capabilities.vadSource} onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, vadSource: event.target.value as ModelCapabilities['vadSource'] } })}><option value="app">App VAD</option><option value="server">模型／Gateway VAD</option></select></label>
          <label>{ui('timestampPrecision')}<select disabled={selectedModel.id === 'none'} value={selectedModel.capabilities.timestampPrecision} onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, timestampPrecision: event.target.value as ModelCapabilities['timestampPrecision'] } })}><option value="chunk">Chunk 邊界</option><option value="segment">Segment</option><option value="word">Word</option></select></label>
          <label>{ui('supportedLanguages')}<input disabled={selectedModel.id === 'none'} value={(selectedModel.capabilities.supportedLanguages ?? []).join(', ')} placeholder="zh-TW, en-US" onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, supportedLanguages: event.target.value.split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z-]{2,20}$/.test(value)).slice(0, 12) } })} /></label>
          <label>{ui('supportedSampleRates')}<input disabled={selectedModel.id === 'none'} value={(selectedModel.capabilities.supportedSampleRates ?? []).join(', ')} placeholder="16000, 44100, 48000" onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, supportedSampleRates: event.target.value.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 8_000 && value <= 192_000).slice(0, 12) } })} /></label>
        </div>
        {apiKeyStatus && <p className="hint">{apiKeyStatus}</p>}<p className="hint">{selectedModel.kind === 'openai-http' ? '收音時將 WAV 分段送到 ASR endpoint，回應文字後立即顯示字幕。' : 'Realtime 模式需要 gateway 實作音訊事件與字幕事件；API key 不會由 Renderer 放進 WebSocket query string。'}</p>
        {selectedModel.id !== 'none' && <button className="danger" onClick={removeSelectedModel}>{ui('removeModel')}</button>}
      </div>
      <div className="text-service-settings vad-settings">
        <p className="eyebrow">{ui('vadAndCaptions')}</p>
        <label>{ui('preRoll')}：{settings.vadConfig.preRollMs} ms<input type="range" min="0" max="1000" step="20" value={settings.vadConfig.preRollMs} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, preRollMs: Number(event.target.value) } }))} /></label>
        <label>{ui('minimumSpeech')}：{settings.vadConfig.minSpeechMs} ms<input type="range" min="20" max="1000" step="20" value={settings.vadConfig.minSpeechMs} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, minSpeechMs: Number(event.target.value) } }))} /></label>
        <label>{ui('silenceToSplit')}：{settings.vadConfig.minSilenceMs} ms<input type="range" min="100" max="5000" step="50" value={settings.vadConfig.minSilenceMs} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, minSilenceMs: Number(event.target.value) } }))} /></label>
        <label>{ui('noiseFloorOffset')}：{settings.vadConfig.noiseFloorOffsetDb} dB<input type="range" min="3" max="30" step="1" value={settings.vadConfig.noiseFloorOffsetDb} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, noiseFloorOffsetDb: Number(event.target.value) } }))} /></label>
        <label><input type="checkbox" checked={settings.denoiseEnabled} onChange={(event) => setDenoiseEnabled(event.target.checked)} />{ui('enableDenoise')}</label>
        <p className="hint">此設定請求瀏覽器的 noiseSuppression，只影響新建或切換的麥克風 stream；保存音檔與送往 ASR 的音訊都使用同一處理後 stream。瀏覽器可能不支援此約束。</p><p className="hint">預設值採 faster-whisper 常用的 500 ms 靜音起點；Breeze HTTP 的時間戳是 App 音訊 chunk 邊界，不是模型 word timestamps。</p>
      </div></>}
      {settingsCategory === 'translation' && <><div className="text-service-settings">
        <p className="eyebrow">{ui('translationApi')}</p><label><input type="checkbox" checked={settings.translationEnabled} onChange={(event) => setSettings((current) => ({ ...current, translationEnabled: event.target.checked }))} />{ui('enableTranslation')}</label><label>{ui('translationStrategy')}<select value={settings.translationStrategy} onChange={(event) => setSettings((current) => ({ ...current, translationStrategy: event.target.value as 'realtime' | 'sentence' }))}><option value="realtime">{ui('realtimeSegment')}</option><option value="sentence">{ui('completeSentence')}</option></select></label><label>{ui('loadStrategy')}<select value={settings.translationLoadStrategy} onChange={(event) => setSettings((current) => ({ ...current, translationLoadStrategy: event.target.value as 'automatic' | 'manual' }))}><option value="automatic">{ui('automaticQueue')}</option><option value="manual">{ui('manualTranslation')}</option></select></label>
        <label>{ui('currentTranslationModel')}<select value={settings.selectedTranslationModelId} onChange={(event) => selectTranslationProfile(event.target.value)}><option value="none">{ui('noTranslationModel')}</option>{settings.translationProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <p className="hint">{ui('translationEndpointHint')}</p>
      </div>
      <div className="text-service-settings">
        <p className="eyebrow">{ui('glossary')}</p>
        <label>{ui('searchGlossary')}<input value={glossarySearch} placeholder={ui('glossarySearchPlaceholder')} onChange={(event) => setGlossarySearch(event.target.value)} /></label>
        <div className="glossary-editor">{glossaryEntries.filter((entry) => entry.value.toLocaleLowerCase().includes(glossarySearch.trim().toLocaleLowerCase())).map((entry) => <div key={entry.index}><input defaultValue={entry.value} aria-label={ui('glossaryTerm')} onBlur={(event) => replaceGlossaryEntry(entry.index, event.currentTarget.value)} /><button className="text-button danger" aria-label={ui('deleteGlossary')} onClick={() => replaceGlossaryEntry(entry.index, '')}>{ui('deleteGlossary')}</button></div>)}{!glossaryEntries.length && <p className="hint">{ui('noGlossary')}</p>}<div><input value={newGlossaryTerm} aria-label={ui('addGlossary')} placeholder={ui('glossaryExample')} onChange={(event) => setNewGlossaryTerm(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addGlossaryEntry() } }} /><button className="secondary" onClick={addGlossaryEntry}>{ui('addGlossary')}</button></div></div>
        <label className="glossary-json-import">{ui('loadGlossaryJson')}<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importGlossaryJson(file) }} /></label>
        <p className="hint">支援 {"{「術語」:「指定譯法」}"} 或 [{"{\"term\":\"術語\",\"translation\":\"指定譯法\"}"}]；載入後請儲存設定。</p>
      </div></>}
      {settingsCategory === 'summary' && <div className="text-service-settings summary-template-manager">
        <p className="eyebrow">{ui('savedTemplates')} <span>{ui('templateManagementHint')}</span></p>
        <section className="saved-template-list" aria-label={ui('savedTemplates')}><div>{settings.summaryTemplates.map((template) => <button key={template.id} className={template.id === settings.selectedSummaryTemplateId ? 'active' : ''} onClick={() => selectSummaryTemplate(template.id)}><span>▤</span>{template.name}</button>)}</div></section>
        <div className="summary-template-preview"><span>{ui('templatePreview')}</span><pre>{settings.summaryTemplate}</pre></div>
        <button className="text-button danger" type="button" onClick={deleteSummaryTemplate}>{ui('deleteCurrentTemplate')}</button>
      </div>}
      {settingsCategory === 'app' && <><div className="text-service-settings"><p className="eyebrow">{ui('application')}</p><label>{ui('theme')}<select value={settings.theme} onChange={(event) => setSettings((current) => ({ ...current, theme: event.target.value as 'system' | 'light' | 'dark' }))}><option value="system">{ui('followSystem')}</option><option value="light">{ui('light')}</option><option value="dark">{ui('dark')}</option></select></label></div>
      {window.s2t && <div className="text-service-settings"><p className="eyebrow">{ui('electronStorageLocation')}</p><label>{ui('defaultSaveTo')}<select value={settings.storageLocation} onChange={(event) => setSettings((current) => ({ ...current, storageLocation: event.target.value as 'local' | 'remote' }))}><option value="local">{ui('local')}</option><option value="remote">{ui('remoteStorage')}</option></select></label><p className="hint">{ui('storageLocationHint')}</p></div>}</>}
      {settingsCategory === 'app' && <div className="text-service-settings"><p className="eyebrow">{ui('interfaceLanguage')}</p><label>{ui('displayLanguage')}<select value={settings.uiLanguage} onChange={(event) => setSettings((current) => ({ ...current, uiLanguage: event.target.value as typeof current.uiLanguage }))}><option value="zh-TW">繁體中文</option><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label></div>}
      <button className="primary" onClick={saveSettings}>{ui('saveSettings')}</button><button className="text-button" onClick={() => setView(settingsReturnView)}>{ui('returnPrevious')}</button>{settingsSaved && <span className="saved">{ui('saved')}</span>}
    </section>
  )

if (isFloatingCaptionWindow) {
    return <main className="floating-caption" aria-live="polite"><header><span>{ui('floatingCaptions')}</span><div><button className="text-button" onClick={toggleFloatingCaptionFullscreen}>{floatingCaptionFullscreen ? ui('exitFullscreen') : ui('fullscreen')}</button><button className="text-button" onClick={closeFloatingCaptions}>{ui('close')}</button></div></header><div className="floating-caption-content"><p>{floatingCaptionText}</p></div></main>
  }

return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">S2T UI</p>
          <h1>{t('appName')}</h1>
        </div>
        <div className="header-account"><span className={`status ${captureState === 'recording' || captureState === 'paused' ? 'active' : ''}`}>{status}</span><button className="menu-toggle" aria-label={ui('openMenu')} aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)}>☰</button></div>
      </header>
      {menuOpen && <><button className="menu-backdrop" aria-label={t('menu')} onClick={() => setMenuOpen(false)} /><aside className="app-menu" aria-label={t('menu')}><div className="app-menu-header"><div><p className="eyebrow">S2T UI</p><h2>{t('menu')}</h2></div><button className="text-button" onClick={() => setMenuOpen(false)}>{ui('close')}</button></div><p className="menu-section">{ui('workspace')}</p>{([{ id: 'live', icon: '◉', label: t('live') }, { id: 'history', icon: '▤', label: t('history') }, { id: 'summary', icon: '☷', label: ui('summary') }, { id: 'import', icon: '↥', label: t('import') }] as const).map((item) => <button key={item.id} className={view === item.id ? 'menu-item active' : 'menu-item'} onClick={() => { setView(item.id); setMenuOpen(false) }}><span>{item.icon}</span>{item.label}</button>)}<p className="menu-section">{ui('management')}</p>{([{ id: 'models', icon: '◇', label: t('models') }, { id: 'voiceprints', icon: '◉', label: t('voiceprints') }, { id: 'settings', icon: '⚙', label: t('settings') }] as const).map((item) => <button key={item.id} className={view === item.id ? 'menu-item active' : 'menu-item'} onClick={() => { if (item.id === 'settings') openSettings(view); else setView(item.id); setMenuOpen(false) }}><span>{item.icon}</span>{item.label}</button>)}{view === 'live' && <><p className="menu-section">{ui('liveTools')}</p><button className="menu-item" onClick={() => { setHistoryCollapsed(false); setSidebarSection('settings'); setMenuOpen(false) }}><span>⚙</span>{ui('quickSettings')}</button></>}<div className="menu-account"><span>{user.NT}</span><small>{user.Department}</small><button className="menu-item menu-logout" onClick={() => void onLogout()}><span>↪</span>{t('logout')}</button></div></aside></>}
      {modelDialogOpen && <div className="transcript-modal-backdrop" role="presentation" onMouseDown={() => setModelDialogOpen(false)}><section className="transcript-modal model-dialog" role="dialog" aria-modal="true" aria-label={t('models')} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">{ui('modelManagement').toUpperCase()}</p><h2>{modelDialogCanDelete ? ui('editModel') : ui('registerModel')}</h2></div><button className="text-button" onClick={() => setModelDialogOpen(false)}>{ui('close')}</button></header><div className="model-actions"><label>{ui('modelPurpose')}<select value={modelPurpose} disabled={Boolean(editingModelId)} onChange={(event) => { const purpose = event.target.value as typeof modelPurpose; setModelPurpose(purpose); setEditingModelId(null); setModelDialogCanDelete(false); setNewModelName(''); setNewModelEndpoint(''); setNewModelId('') }}><option value="asr">{ui('speechRecognition')}</option><option value="translation">{ui('translation')}</option><option value="summary">{ui('summaryTitle')}</option><option value="diarization">{ui('speakerDiarization')}</option></select></label><input value={newModelName} placeholder={ui('modelDisplayName')} onChange={(event) => setNewModelName(event.target.value)} /><input type="url" value={newModelEndpoint} placeholder={ui('endpointUrl')} onChange={(event) => setNewModelEndpoint(event.target.value)} /><input value={newModelId} placeholder={ui('modelId')} onChange={(event) => setNewModelId(event.target.value)} /><label><input type="checkbox" checked={!newModelRequiresApiKey} onChange={(event) => setNewModelRequiresApiKey(!event.target.checked)} />{ui('apiKeyNotRequired')}</label>{newModelRequiresApiKey && <input type="password" autoComplete="off" value={newModelApiKey} placeholder={ui('encryptedApiKey')} onChange={(event) => setNewModelApiKey(event.target.value)} />}{modelPurpose === 'asr' && <><label className="model-transport-toggle"><input type="checkbox" checked={newModelUsesBuiltin} onChange={(event) => setNewModelUsesBuiltin(event.target.checked)} />{ui('builtInSegmentation')}</label><div className="model-capabilities"><label>{ui('asrMode')}<select value={modelCapabilities.asrMode} onChange={(event) => setModelCapabilities((current) => ({ ...current, asrMode: event.target.value as ModelCapabilities['asrMode'] }))}><option value="non-streaming">Non-streaming（分段）</option><option value="streaming">Streaming（原生串流）</option></select></label><label>{ui('vadSource')}<select value={modelCapabilities.vadSource} onChange={(event) => setModelCapabilities((current) => ({ ...current, vadSource: event.target.value as ModelCapabilities['vadSource'] }))}><option value="app">App VAD</option><option value="server">模型／Gateway VAD</option></select></label><label>{ui('timestampPrecision')}<select value={modelCapabilities.timestampPrecision} onChange={(event) => setModelCapabilities((current) => ({ ...current, timestampPrecision: event.target.value as ModelCapabilities['timestampPrecision'] }))}><option value="chunk">Chunk 邊界</option><option value="segment">Segment</option><option value="word">Word</option></select></label><label>{ui('supportedLanguages')}<input value={(modelCapabilities.supportedLanguages ?? []).join(', ')} placeholder="zh-TW, en-US" onChange={(event) => setModelCapabilities((current) => ({ ...current, supportedLanguages: event.target.value.split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z-]{2,20}$/.test(value)).slice(0, 12) }))} /></label><label>{ui('supportedSampleRates')}<input value={(modelCapabilities.supportedSampleRates ?? []).join(', ')} placeholder="16000, 44100, 48000" onChange={(event) => setModelCapabilities((current) => ({ ...current, supportedSampleRates: event.target.value.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 8_000 && value <= 192_000).slice(0, 12) }))} /></label></div><p className="hint">未填寫能力時，App 會使用裝置原生取樣率，不會假定服務支援特定格式。</p></>}<div className="model-dialog-actions"><button className="primary" onClick={saveManagedModel}>{modelDialogCanDelete ? ui('saveChanges') : ui('registerModel')}</button>{modelDialogCanDelete && <button className="danger" onClick={deleteManagedModel}>{ui('deleteModel')}</button>}</div></div></section></div>}
      <div className={`app-layout ${view === 'live' ? 'live-layout' : ''}`}>
        {view === 'live' && <aside className={historyCollapsed ? 'history-sidebar collapsed' : 'history-sidebar'} aria-label={`${ui('historyRecords')} / ${ui('quickSettings')}`}>
          {historyCollapsed ? <nav className="sidebar-icon-rail" aria-label={ui('workspace')}><button className="sidebar-icon-button" aria-label={ui('openHistory')} title={ui('historyRecords')} onClick={() => { setSidebarSection('history'); setHistoryCollapsed(false) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM9 4v16M12 8h5M12 12h5M12 16h3" /></svg></button><button className="sidebar-icon-button" aria-label={ui('openQuickSettings')} title={ui('quickSettings')} onClick={() => { setSidebarSection('settings'); setHistoryCollapsed(false) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 13.2 6a7 7 0 0 1 1.7.7l2.6-.9 1.8 1.8-.9 2.6c.3.5.5 1.1.7 1.7l2.5 1.2v2.5l-2.5 1.2a7 7 0 0 1-.7 1.7l.9 2.6-1.8 1.8-2.6-.9a7 7 0 0 1-1.7.7L12 20.5H9.5L8.3 18a7 7 0 0 1-1.7-.7l-2.6.9-1.8-1.8.9-2.6a7 7 0 0 1-.7-1.7L.5 13.5V11l2.5-1.2a7 7 0 0 1 .7-1.7l-.9-2.6L4.6 3.7l2.6.9a7 7 0 0 1 1.7-.7l1.2-2.5H12Z" /><circle cx="11" cy="12" r="2.5" /></svg></button></nav> : <><div className="sidebar-topbar"><span>{ui('workspace')}</span><button className="text-button history-toggle" aria-label={ui('collapseSidebar')} title={ui('collapseSidebar')} onClick={() => setHistoryCollapsed(true)}>‹</button></div><nav className="sidebar-tabs" aria-label={ui('workspace')}><button className={sidebarSection === 'history' ? 'active' : ''} onClick={() => setSidebarSection('history')}>{ui('historyRecords')}</button><button className={sidebarSection === 'settings' ? 'active' : ''} onClick={() => setSidebarSection('settings')}>{ui('quickSettings')}</button></nav>
          {sidebarSection === 'history' && <div className="history-sidebar-list">{sessions.length ? sessions.slice(0, 40).map((entry) => <button key={entry.id} className="history-sidebar-item" title={`載入 ${entry.title} 到即時字幕`} onClick={() => loadSessionIntoLive(entry)}><strong>{entry.title}</strong><small>{new Date(entry.createdAt).toLocaleDateString(settings.uiLanguage)}</small></button>) : <p>{ui('noHistory')}</p>}<button className="text-button history-all-button" onClick={() => setView('history')}>{ui('allHistory')}</button></div>}
          {sidebarSection === 'settings' && <section className="history-quick-settings"><div className="history-quick-settings-content"><label>{ui('microphone')}<select value={selectedDeviceId} onChange={(event) => selectDevice(event.target.value)} disabled={captureState === 'saving' || captureState === 'starting'}><option value="default">{ui('systemDefaultMicrophone')}</option><option value="none">{ui('notInUse')}</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label><div className="meter" aria-label={`${ui('microphoneLevel')} ${dbfsLabel(microphoneLevel)}`}><div className="meter-label"><span>{ui('microphoneLevel')}</span><strong>{dbfsLabel(microphoneLevel)}</strong></div><div className="meter-track"><div ref={microphoneMeterValueRef} className="meter-value" style={{ width: `${meterPercent(microphoneLevel)}%` }} /></div></div><label>{ui('computerAudio')}<select value={includeSystemAudio ? 'system' : 'none'} onChange={(event) => void selectSystemAudio(event.target.value === 'system')} disabled={captureState === 'saving' || captureState === 'starting'}><option value="none">{ui('notInUse')}</option><option value="system">{ui('chooseComputerAudio')}</option></select></label><div className="meter" aria-label={`${ui('computerAudioLevel')} ${dbfsLabel(systemLevel)}`}><div className="meter-label"><span>{ui('computerAudioLevel')}</span><strong>{systemStreamRef.current ? dbfsLabel(systemLevel) : ui('notConnected')}</strong></div><div className="meter-track"><div ref={systemMeterValueRef} className="meter-value" style={{ width: `${meterPercent(systemLevel)}%` }} /></div></div><label>{ui('sourceLanguage')}<select value={settings.sourceLanguage} onChange={(event) => setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="auto">{ui('autoDetect')}</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option><option value="de-DE">Deutsch</option></select></label><label><input type="checkbox" checked={settings.translationEnabled} onChange={(event) => setSettings((current) => ({ ...current, translationEnabled: event.target.checked }))} />{ui('enableTranslation')}</label><label>{ui('targetLanguage')}<select value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label><label>{ui('asrModel')}<select disabled={captureState !== 'idle'} value={settings.selectedModelId} onChange={(event) => setSettings((current) => ({ ...current, selectedModelId: event.target.value }))}>{settings.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><button className="text-button" onClick={() => void refreshDevices().catch(() => setStatus('無法重新整理音源裝置'))} disabled={captureState === 'starting' || captureState === 'saving'}>{ui('refreshAudioSources')}</button><button className="secondary" onClick={() => openSettings('live')}>{ui('fullSettings')}</button></div></section>}</>}
        </aside>}
        <section className="workspace-content">{workspace}</section>
      </div>
    </main>
  )
}
