import { type SavedSession, type ModelCapabilities, type ModelProfile } from '../../../shared/types'
import { dbfsLabel, meterPercent } from '../../../shared/services/audio'
import { timestamp } from '../../../shared/services/transcript'
import { modelEndpoint, textEndpoint } from '../../../shared/services/settings'
import { type CSSProperties, type ReactElement, useState } from 'react'

import type { AppController } from '../hooks/useAppController'
import type { AuthUser } from '../../auth/services/auth-client'

export function AppView({ controller, user, onLogout }: { controller: AppController; user: AuthUser; onLogout: () => Promise<void> }): ReactElement {
const [menuOpen, setMenuOpen] = useState(false)
const [settingsCategory, setSettingsCategory] = useState<'asr' | 'translation' | 'summary' | 'speakers' | 'app'>('asr')
const [modelDialogOpen, setModelDialogOpen] = useState(false)
const [quickSettingsOffset, setQuickSettingsOffset] = useState({ x: 0, y: 0 })
const startQuickSettingsDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
  const pointerStart = { x: event.clientX, y: event.clientY }
  const offsetStart = quickSettingsOffset
  const move = (pointer: PointerEvent): void => setQuickSettingsOffset({ x: offsetStart.x + pointer.clientX - pointerStart.x, y: offsetStart.y + pointer.clientY - pointerStart.y })
  const stop = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
}
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
voiceprints,
voiceprintCaptureState,
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
systemStreamRef,
microphoneMeterValueRef,
systemMeterValueRef,
transcriptContainerRef,
webCaptionPopupRef,
selectedModel,
refreshDevices,
requestTranslation,
selectDevice,
selectSystemAudio,
startCapture,
togglePause,
stopCapture,
exportTranscript,
copyTranscript,
updateTranscript,
updateSpeaker,
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
diarizeSession,
deleteSession,
saveSessionToDisk,
openSavedSession,
saveTextServiceKey,
enrollVoiceprint,
deleteVoiceprint,
startVoiceprintCapture,
stopVoiceprintCapture,
createSummary,
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
renameSession
} = controller

const sessionTranscript = (entry: SavedSession, query: string): ReactElement => entry.segments?.length ? <>
    {entry.segments.filter((segment) => segment.status !== 'gap' && `${segment.speaker ?? ''} ${segment.sourceText} ${segment.translatedText ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((segment) => <article key={segment.id}>
      <time>{timestamp(segment.startMs)}</time>
      {segment.speaker && <span className="speaker-row">{segment.speaker}</span>}
      <p>{segment.sourceText}</p>
      {segment.translatedText && <p className="translation">{segment.translatedText}</p>}
    </article>)}
  </> : <pre>{entry.transcript || '這筆紀錄沒有字幕。'}</pre>

const liveWorkspace = (
    <div className="live-workspace">
      <section className="caption-window" style={{ '--caption-scale': captionScale } as CSSProperties}>
        <div className="live-caption-heading"><div><p className="eyebrow">LIVE CAPTIONS</p><h2>即時字幕</h2></div><div className="caption-actions"><span>{visibleTranscripts.length} 段</span><button className="text-button caption-size-button" aria-label="縮小字幕" title="縮小字幕" disabled={captionScale <= .8} onClick={() => setCaptionScale((scale) => Math.max(.8, Number((scale - .1).toFixed(1))))}>小A</button><button className="text-button caption-size-button" aria-label="放大字幕" title="放大字幕" disabled={captionScale >= 1.6} onClick={() => setCaptionScale((scale) => Math.min(1.6, Number((scale + .1).toFixed(1))))}>大A</button><button className="text-button" disabled={!visibleTranscripts.length} onClick={clearCaptions}>清除畫面</button>{!followingCaptions && <button className="text-button" onClick={() => setFollowingCaptions(true)}>回到最新</button>}</div></div>
        <div className="transcript-tools"><input aria-label="搜尋字幕" value={transcriptSearch} placeholder="搜尋字幕" onChange={(event) => setTranscriptSearch(event.target.value)} /><span>{searchedTranscripts.length} 段</span></div>
        <section ref={transcriptContainerRef} className="transcript" aria-live="polite" title="點擊此區開啟彈出字幕" onClick={(event) => { const target = event.target as HTMLElement; if (!target.closest('button, select, textarea, input')) openFloatingCaptions() }} onScroll={(event) => { const element = event.currentTarget; setFollowingCaptions(element.scrollHeight - element.scrollTop - element.clientHeight < 48) }}>
        {visibleTranscripts.length === 0 ? (
          <div className="empty"><h2>等待語音</h2><p>開始收音後，原文與翻譯會顯示在這裡。</p></div>
        ) : <>{searchedTranscripts.map((entry) => (
          <article key={entry.id} className={entry.status}>
            <time>{timestamp(entry.startMs)}</time>
            {editingTranscriptId === entry.id ? <div className="transcript-edit"><div className="timing-inputs"><label>開始（ms）<input type="number" min="0" defaultValue={entry.startMs} onBlur={(event) => updateTranscriptTiming(entry.id, Number(event.currentTarget.value), entry.endMs)} /></label><label>結束（ms）<input type="number" min="1" defaultValue={entry.endMs} onBlur={(event) => updateTranscriptTiming(entry.id, entry.startMs, Number(event.currentTarget.value))} /></label></div><textarea value={entry.sourceText} onChange={(event) => updateTranscript(entry.id, event.target.value, entry.translatedText ?? '')} /><textarea value={entry.translatedText ?? ''} placeholder="翻譯（選填）" onChange={(event) => updateTranscript(entry.id, entry.sourceText, event.target.value)} /><button className="text-button" onClick={() => setEditingTranscriptId(null)}>完成編輯</button></div> : <><div className="speaker-row"><input aria-label="講者名稱" value={entry.speaker ?? ''} placeholder="未標記講者" onChange={(event) => updateSpeaker(entry.id, event.target.value)} /></div><p>{entry.sourceText}</p>{entry.translatedText && <p className="translation">{entry.translatedText}</p>}{entry.translationStatus === 'failed' && <button className="text-button translation-retry" onClick={() => { setTranscripts((current) => current.map((currentEntry) => currentEntry.id === entry.id ? { ...currentEntry, translationStatus: undefined } : currentEntry)); void requestTranslation({ ...entry, translationStatus: undefined }) }}>重新翻譯</button>}<button className="edit-button" onClick={() => setEditingTranscriptId(entry.id)}>編輯</button></>}
          </article>
        ))}</>}
      </section>

      </section>

      {webCaptionPopup && <div ref={webCaptionPopupRef} className="transcript-modal-backdrop web-caption-popup" role="presentation" onMouseDown={closeWebCaptionPopup}><section className="transcript-modal" role="dialog" aria-modal="true" aria-label="即時字幕彈出視窗" onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">LIVE CAPTIONS</p><h2>即時字幕</h2></div><div><button className="text-button" onClick={toggleWebCaptionFullscreen}>{webCaptionFullscreen ? '退出全螢幕' : '全螢幕'}</button><button className="text-button" onClick={closeWebCaptionPopup}>關閉</button></div></header><div className="session-transcript">{visibleTranscripts.length ? visibleTranscripts.slice(-8).map((entry) => <article key={entry.id}><time>{timestamp(entry.startMs)}</time><p>{entry.sourceText}</p>{entry.translatedText && <p className="translation">{entry.translatedText}</p>}</article>) : <p>等待字幕</p>}</div></section></div>}
      <section className="capture-panel" aria-label="音訊來源與音量">
        <label className="source-field">麥克風<select value={selectedDeviceId} onChange={(event) => selectDevice(event.target.value)} disabled={captureState === 'saving' || captureState === 'starting'}><option value="default">系統預設麥克風</option><option value="none">不使用</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>
        <div className="meter" aria-label={`麥克風音量 ${dbfsLabel(microphoneLevel)}`}><div className="meter-label"><span>麥克風音量</span><strong>{dbfsLabel(microphoneLevel)}</strong></div><div className="meter-track"><div ref={microphoneMeterValueRef} className="meter-value" style={{ width: `${meterPercent(microphoneLevel)}%` }} /></div></div>
        <label className="source-field">電腦音訊<select value={includeSystemAudio ? 'system' : 'none'} onChange={(event) => void selectSystemAudio(event.target.value === 'system')} disabled={captureState === 'saving' || captureState === 'starting'}><option value="none">不使用</option><option value="system">選擇電腦音訊</option></select></label>
        <div className="meter" aria-label={`電腦音訊音量 ${dbfsLabel(systemLevel)}`}><div className="meter-label"><span>電腦音訊音量</span><strong>{systemStreamRef.current ? dbfsLabel(systemLevel) : '未連接'}</strong></div><div className="meter-track"><div ref={systemMeterValueRef} className="meter-value" style={{ width: `${meterPercent(systemLevel)}%` }} /></div></div>
        <div className="source-capture-row"><div className="capture-controls"><button className="secondary" onClick={() => void refreshDevices().catch(() => setStatus('無法重新整理音源裝置'))} disabled={captureState === 'starting' || captureState === 'saving'}>刷新</button>{canRecord ? <button className="primary" disabled={selectedDeviceId === 'none' && !includeSystemAudio} onClick={() => void startCapture()}>開始收音</button> : captureState === 'starting' || captureState === 'saving' ? <button className="secondary" disabled>{captureState === 'starting' ? '正在連接…' : '正在保存…'}</button> : <><button className="secondary" onClick={() => void togglePause()}>{captureState === 'paused' ? '繼續' : '暫停'}</button><button className="danger" onClick={() => void stopCapture()}>結束收音</button></>}</div><div className="timer">{timestamp(elapsedMs)}</div></div>
      </section>
      {(summaryStatus || summaryText) && <section className="summary-panel"><div className="meter-label"><span>會議紀錄</span><strong>{summaryStatus}</strong></div>{summaryText && <pre>{summaryText}</pre>}</section>}

    </div>
  )

const workspace = view === 'live' ? liveWorkspace : view === 'history' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">HISTORY</p><h2>錄音與逐字稿記錄</h2></div><div className="history-title-actions">{window.s2t && <button className="secondary" onClick={() => void openSavedSession()}>開啟已保存工作階段</button>}<span>{filteredSessions.length} 筆</span></div></div>
      {sessions.length === 0 ? <div className="empty compact"><h2>還沒有記錄</h2><p>完成一次錄音後，會議資料會出現在這裡。</p></div> : <>
        <div className="history-pagination"><label>搜尋紀錄<input value={historySearch} placeholder="名稱、內容、講者" onChange={(event) => { setHistorySearch(event.target.value); setHistoryPage(1) }} /></label><label>排序<select value={historySort} onChange={(event) => { setHistorySort(event.target.value as 'title' | 'createdAt' | 'durationMs'); setHistoryPage(1) }}><option value="createdAt">時間</option><option value="title">名稱</option><option value="durationMs">時長</option></select></label><button className="text-button" onClick={() => setHistorySortDirection((current) => current === 'asc' ? 'desc' : 'asc')}>{historySortDirection === 'asc' ? '升冪' : '降冪'}</button><label>每頁筆數<select value={historyPageSize} onChange={(event) => { setHistoryPageSize(Number(event.target.value)); setHistoryPage(1) }}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label><span>第 {currentHistoryPage}／{historyPageCount} 頁</span><button className="text-button" disabled={currentHistoryPage === 1} onClick={() => setHistoryPage((current) => Math.max(1, current - 1))}>上一頁</button><button className="text-button" disabled={currentHistoryPage === historyPageCount} onClick={() => setHistoryPage((current) => Math.min(historyPageCount, current + 1))}>下一頁</button></div>
        <div className="session-list">{pagedSessions.map((entry) => <article key={entry.id} className="session-item">
          <div className="session-details">{renamingSessionId === entry.id ? <form className="session-rename" onSubmit={(event) => { event.preventDefault(); renameSession(entry.id) }}><input autoFocus aria-label="紀錄標題" maxLength={200} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onBlur={() => renameSession(entry.id)} onKeyDown={(event) => { if (event.key === 'Escape') { setTitleDraft(entry.title); setRenamingSessionId(null) } }} /></form> : <button className="session-title" title="點擊修改標題" onClick={() => { setRenamingSessionId(entry.id); setTitleDraft(entry.title) }}>{entry.title}</button>}<p>{new Date(entry.createdAt).toLocaleString('zh-TW')} · {timestamp(entry.durationMs)} · {entry.source}{entry.savedToDisk ? ' · 已保存' : ' · 尚未保存'}</p>{entry.summary && <p className="session-summary">摘要：{entry.summary}</p>}{playingSessionId === entry.id && playbackUrl && <audio controls autoPlay src={playbackUrl}>此瀏覽器不支援音訊播放。</audio>}</div>
          <div className="session-actions">{!entry.savedToDisk && <button className="primary" onClick={() => void saveSessionToDisk(entry)}>儲存</button>}<button className="icon-action" aria-label="查看字幕" title="查看字幕" onClick={() => setViewingSessionId(entry.id)}>▤</button><button className="icon-action" aria-label="產生會議整理" title="產生會議整理" onClick={() => void summarizeSession(entry)}>☷</button><button className="icon-action" aria-label="自動識別講者" title="自動識別講者" onClick={() => void diarizeSession(entry)}>◉</button><button className="icon-action" aria-label="播放錄音" title="播放錄音" onClick={() => void playSession(entry)}>▶</button><button className="secondary download-action" onClick={() => void downloadSessionAudio(entry)}>WAV ↓</button><button className="secondary download-action" onClick={() => exportSavedTranscript(entry, 'vtt')}>VTT ↓</button><button className="icon-action" aria-label="複製逐字稿" title="複製逐字稿" onClick={() => void copyTranscript(entry.segments)}>▣</button><button className="icon-action danger" aria-label="刪除記錄" title="刪除記錄" onClick={() => void deleteSession(entry)}>⌫</button></div>
        </article>)}</div>
      </>}
      {viewingSession && <div className="transcript-modal-backdrop" role="presentation" onMouseDown={() => setViewingSessionId(null)}><section className="transcript-modal" role="dialog" aria-modal="true" aria-label={`${viewingSession.title} 逐字稿`} onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">TRANSCRIPT</p><h2>{viewingSession.title}</h2></div><button className="text-button" onClick={() => { setViewingSessionId(null); setSessionTranscriptSearch('') }}>關閉</button></header><div className="transcript-tools"><input aria-label="搜尋此紀錄" value={sessionTranscriptSearch} placeholder="搜尋原文、翻譯或講者" onChange={(event) => setSessionTranscriptSearch(event.target.value)} /></div><div className="session-transcript">{sessionTranscript(viewingSession, sessionTranscriptSearch)}</div></section></div>}
    </section>
  ) : view === 'models' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">MODELS</p><h2>已設定模型</h2></div><div className="page-title-actions"><span>{settings.modelProfiles.filter((profile) => profile.id !== 'none').length + settings.translationProfiles.length + (settings.diarizationModel ? 1 : 0) + (settings.summaryModel ? 1 : 0)} 個</span><button className="primary" onClick={() => setModelDialogOpen(true)}>註冊模型</button></div></div>
      <nav className="model-filter" aria-label="模型類別">{(['all', 'asr', 'translation', 'summary', 'diarization'] as const).map((filter) => <button key={filter} className={modelFilter === filter ? 'nav-active' : ''} onClick={() => setModelFilter(filter)}>{{ all: '全部', asr: 'ASR', translation: '翻譯', summary: '摘要', diarization: '講者分離' }[filter]}</button>)}</nav>
      <div className="model-list">
        {(modelFilter === 'all' || modelFilter === 'asr') && settings.modelProfiles.filter((profile) => profile.id !== 'none').map((profile) => <article className="model-list-item model-asr" key={profile.id}><div><strong>{profile.name}</strong><p>ASR · {profile.kind === 'openai-http' ? 'OpenAI Speech-to-Text / 分段 HTTP' : 'Realtime WebSocket'} · {profile.model}</p><code>{modelEndpoint(profile.endpoint, profile.kind)}</code></div></article>)}
        {(modelFilter === 'all' || modelFilter === 'translation') && settings.translationProfiles.map((profile) => <article className="model-list-item model-translation" key={profile.id}><div><strong>{profile.name}</strong><p>翻譯 · OpenAI Chat Completions · {profile.model}</p><code>{textEndpoint(profile.endpoint)}</code></div></article>)}
        {(modelFilter === 'all' || modelFilter === 'summary') && settings.summaryModel && <article className="model-list-item model-summary"><div><strong>{settings.summaryModel}</strong><p>摘要 · OpenAI Chat Completions</p><code>{textEndpoint(settings.summaryEndpoint)}</code></div></article>}
        {(modelFilter === 'all' || modelFilter === 'diarization') && settings.diarizationModel && <article className="model-list-item model-diarization"><div><strong>{settings.diarizationModel}</strong><p>講者分離 · {settings.diarizationEndpoint === '/api/diarizations' ? 'Web gateway / sherpa-onnx' : settings.diarizationEndpoint.includes('127.0.0.1') || settings.diarizationEndpoint.includes('localhost') ? '本機 sherpa-onnx' : '遠端 API'}</p><code>{settings.diarizationEndpoint}</code></div></article>}
        {settings.modelProfiles.every((profile) => profile.id === 'none') && !settings.translationProfiles.length && !settings.diarizationModel && !settings.summaryModel && <div className="empty compact"><h2>尚未設定模型</h2><p>請到完整設定新增模型與服務。</p></div>}
      </div>
    </section>
  ) : view === 'voiceprints' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">VOICEPRINTS</p><h2>聲紋管理</h2></div></div>
      <div className="text-service-settings"><p className="eyebrow">聲紋註冊</p><div className="model-actions">{voiceprintCaptureState === 'recording' ? <button className="danger" onClick={() => void stopVoiceprintCapture()}>結束錄音</button> : <button className="secondary" disabled={captureState !== 'idle'} onClick={() => void startVoiceprintCapture()}>直接收音錄製</button>}<span>{voiceprintCaptureState === 'recording' ? '錄音中…請持續說話。' : voiceprintFile ? `已準備：${voiceprintFile.name}` : '尚未選擇樣本'}</span></div><label>單一講者 WAV 樣本<input type="file" accept="audio/wav,.wav" onChange={(event) => setVoiceprintFile(event.target.files?.[0] ?? null)} /></label><button className="secondary" disabled={!voiceprintFile} onClick={() => void enrollVoiceprint()}>註冊我的聲紋</button><p className="hint">可直接收音或上傳至少 1 秒、安靜環境下的單一講者 PCM16 WAV。註冊名稱取自目前登入帳號的 NT；自動分群命中後會顯示此名稱，使用者仍可直接在字幕修改。</p>{voiceprints.length > 0 && <div className="voiceprint-list">{voiceprints.map((voiceprint) => <div key={voiceprint.id}><span>{voiceprint.NT} · {voiceprint.Department} · {new Date(voiceprint.createdAt).toLocaleString('zh-TW')}</span><button className="text-button danger" onClick={() => void deleteVoiceprint(voiceprint.id)}>刪除</button></div>)}</div>}</div>
    </section>
  ) : view === 'import' ? (
    <section className="page-panel">
      <div className="page-title"><div><p className="eyebrow">IMPORT</p><h2>匯入音訊或影片</h2></div></div>
      <label className="drop-zone"><input type="file" disabled={Boolean(importProgress)} accept=".wav,.mp3,.m4a,.aac,.ogg,.webm,.flac,.mp4,.mov" onChange={(event) => selectImportFile(event.target.files?.[0] ?? null)} /><strong>選擇檔案</strong><span>支援 WAV、MP3、M4A、AAC、OGG、WebM、FLAC、MP4、MOV，最大 2 GB</span></label>
      {importError && <p className="import-error" role="alert">{importError}</p>}
      {importedFile && <div className="import-result"><strong>{importedFile.name}</strong><span>{(importedFile.size / 1024 / 1024).toFixed(1)} MB · {importedFile.type || '未知格式'}</span><p>{importedFile.name.toLowerCase().endsWith('.wav') ? 'PCM16 WAV 會每 45 秒切段，保留 1.5 秒重疊並自動去除重複文字。' : '其他格式會以單一請求上傳；大於 100 MB 時請先轉成 PCM16 WAV。'}</p>{importProgress ? <div className="batch-progress"><span>正在轉錄第 {importProgress.current} / {importProgress.total} 段</span><progress value={importProgress.current} max={importProgress.total} /><button className="danger" onClick={cancelImport}>取消批次轉錄</button></div> : <button className="primary" onClick={() => void transcribeImportedFile()}>開始批次轉錄</button>}</div>}
    </section>
  ) : (
    <section className="page-panel settings-panel">
      <div className="page-title"><div><p className="eyebrow">SETTINGS</p><h2>轉錄與模型設定</h2></div></div>
      <nav className="settings-category-nav" aria-label="設定分類">{([{ id: 'asr', label: '轉錄與 VAD' }, { id: 'translation', label: '翻譯與術語' }, { id: 'summary', label: '摘要整理' }, { id: 'speakers', label: '講者分離' }, { id: 'app', label: '應用程式' }] as const).map((category) => <button key={category.id} className={settingsCategory === category.id ? 'nav-active' : ''} onClick={() => setSettingsCategory(category.id)}>{category.label}</button>)}</nav>
      {settingsCategory === 'translation' && <><label>來源語言<select value={settings.sourceLanguage} onChange={(event) => setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="auto">自動偵測</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option><option value="de-DE">Deutsch</option></select></label>
      <label>目標語言<select value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label></>}
      {settingsCategory === 'asr' && <><div className="model-settings">
        <p className="eyebrow">ASR 語音模型</p>
        <label>目前模型<select value={settings.selectedModelId} onChange={(event) => setSettings((current) => ({ ...current, selectedModelId: event.target.value }))}>{settings.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>模型名稱<input value={selectedModel.name} disabled={selectedModel.id === 'none'} onChange={(event) => updateSelectedModel({ name: event.target.value })} /></label>
        <label className="system-audio-option"><input type="checkbox" disabled={selectedModel.id === 'none'} checked={selectedModel.kind === 'openai-http'} onChange={(event) => {
          const kind: ModelProfile['kind'] = event.target.checked ? 'openai-http' : 'websocket'
          updateSelectedModel({ kind, endpoint: modelEndpoint(selectedModel.endpoint, kind) })
        }} /><span><strong>使用內建分段轉錄</strong>{selectedModel.kind === 'openai-http' ? '適用 Breeze-ASR-25：WAV 分段送到 /v1/audio/transcriptions。' : '未勾選：使用自建 Realtime gateway，預設 /v1/realtime。'}</span></label>
        <p className="hint model-api-kind">{selectedModel.kind === 'openai-http' ? 'OpenAI Speech-to-Text：multipart/form-data → /v1/audio/transcriptions（0.8–1.5 秒音訊片段）' : 'Realtime WebSocket：本 App 使用 docs/MODEL_ADAPTER.md 的自建 gateway 協定。'}</p>
        <label>{selectedModel.kind === 'openai-http' ? 'ASR API endpoint' : 'Realtime WebSocket endpoint'}<input type="url" placeholder={selectedModel.kind === 'openai-http' ? 'https://host.example/v1/audio/transcriptions' : 'wss://host.example/v1/realtime'} disabled={selectedModel.id === 'none'} value={selectedModel.endpoint} onChange={(event) => updateSelectedModel({ endpoint: event.target.value })} /></label>
        <label>ASR model ID<input placeholder="Breeze-ASR-25" disabled={selectedModel.id === 'none'} value={selectedModel.model} onChange={(event) => updateSelectedModel({ model: event.target.value })} /></label>
        <div className="capability-fields">
          <label>ASR 模式<select disabled={selectedModel.id === 'none'} value={selectedModel.capabilities.asrMode} onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, asrMode: event.target.value as ModelCapabilities['asrMode'] } })}><option value="non-streaming">Non-streaming（分段）</option><option value="streaming">Streaming（原生串流）</option></select></label>
          <label>VAD 來源<select disabled={selectedModel.id === 'none'} value={selectedModel.capabilities.vadSource} onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, vadSource: event.target.value as ModelCapabilities['vadSource'] } })}><option value="app">App VAD</option><option value="server">模型／Gateway VAD</option></select></label>
          <label>時間戳精度<select disabled={selectedModel.id === 'none'} value={selectedModel.capabilities.timestampPrecision} onChange={(event) => updateSelectedModel({ capabilities: { ...selectedModel.capabilities, timestampPrecision: event.target.value as ModelCapabilities['timestampPrecision'] } })}><option value="chunk">Chunk 邊界</option><option value="segment">Segment</option><option value="word">Word</option></select></label>
        </div>
        {window.s2t && <div className="api-key-row"><label>ASR API key<input type="password" autoComplete="off" placeholder="貼上後會加密儲存" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} /></label><button className="secondary" onClick={() => void saveApiKey()} disabled={selectedModel.id === 'none'}>儲存 API key</button></div>}
        {apiKeyStatus && <p className="hint">{apiKeyStatus}</p>}<p className="hint">{selectedModel.kind === 'openai-http' ? '收音時將 WAV 分段送到 ASR endpoint，回應文字後立即顯示字幕。' : 'Realtime 模式需要 gateway 實作音訊事件與字幕事件；API key 不會由 Renderer 放進 WebSocket query string。'}</p>
        {selectedModel.id !== 'none' && <button className="danger" onClick={removeSelectedModel}>刪除此模型</button>}
      </div>
      <div className="text-service-settings vad-settings">
        <p className="eyebrow">App VAD 與字幕切段</p>
        <label>句首保留：{settings.vadConfig.preRollMs} ms<input type="range" min="0" max="1000" step="20" value={settings.vadConfig.preRollMs} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, preRollMs: Number(event.target.value) } }))} /></label>
        <label>起音持續：{settings.vadConfig.minSpeechMs} ms<input type="range" min="20" max="1000" step="20" value={settings.vadConfig.minSpeechMs} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, minSpeechMs: Number(event.target.value) } }))} /></label>
        <label>停頓斷句：{settings.vadConfig.minSilenceMs} ms<input type="range" min="100" max="5000" step="50" value={settings.vadConfig.minSilenceMs} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, minSilenceMs: Number(event.target.value) } }))} /></label>
        <label>噪音底線偏移：{settings.vadConfig.noiseFloorOffsetDb} dB<input type="range" min="3" max="30" step="1" value={settings.vadConfig.noiseFloorOffsetDb} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, noiseFloorOffsetDb: Number(event.target.value) } }))} /></label>
        <p className="hint">預設值採 faster-whisper 常用的 500 ms 靜音起點；Breeze HTTP 的時間戳是 App 音訊 chunk 邊界，不是模型 word timestamps。</p>
      </div></>}
      {settingsCategory === 'translation' && <><div className="text-service-settings">
        <p className="eyebrow">翻譯 API</p><label><input type="checkbox" checked={settings.translationEnabled} onChange={(event) => setSettings((current) => ({ ...current, translationEnabled: event.target.checked }))} />啟用翻譯</label><label>翻譯策略<select value={settings.translationStrategy} onChange={(event) => setSettings((current) => ({ ...current, translationStrategy: event.target.value as 'realtime' | 'sentence' }))}><option value="realtime">即時逐段</option><option value="sentence">完整句子</option></select></label>
        <label>目前翻譯模型<select value={settings.selectedTranslationModelId} onChange={(event) => selectTranslationProfile(event.target.value)}><option value="none">未選擇翻譯模型</option>{settings.translationProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>Chat Completions endpoint<input type="url" placeholder="https://host.example/v1/chat/completions" value={settings.translationEndpoint} onChange={(event) => setSettings((current) => ({ ...current, translationEndpoint: event.target.value }))} /></label>
        <label>Translation model ID<input value={settings.translationModel} onChange={(event) => setSettings((current) => ({ ...current, translationModel: event.target.value }))} /></label>
        {window.s2t && <div className="api-key-row"><label>翻譯 API key<input type="password" autoComplete="off" value={translationKeyDraft} onChange={(event) => setTranslationKeyDraft(event.target.value)} /></label><button className="secondary" onClick={() => void saveTextServiceKey('translation', translationKeyDraft, () => setTranslationKeyDraft(''))}>儲存 API key</button><button className="secondary" onClick={saveTranslationProfile}>儲存為翻譯模型</button></div>}
        <p className="hint">每段 ASR final 字幕會自動送到此 OpenAI 相容 Chat Completions endpoint，並更新同一段的譯文。</p>
      </div>
      <div className="text-service-settings">
        <p className="eyebrow">術語表</p>
        <label>熱詞／術語表<textarea value={settings.glossary} placeholder="例如：Codex、Breeze、公司名稱、專有名詞" onChange={(event) => setSettings((current) => ({ ...current, glossary: event.target.value }))} /></label>
        <p className="hint">術語會送給 HTTP ASR 的 prompt 與翻譯提示。</p>
      </div></>}
      {settingsCategory === 'summary' && <div className="text-service-settings">
        <p className="eyebrow">會議摘要與整理</p>
        <label>摘要 Chat Completions 位址<input type="url" placeholder="https://host.example/v1/chat/completions" value={settings.summaryEndpoint} onChange={(event) => setSettings((current) => ({ ...current, summaryEndpoint: event.target.value }))} /></label>
        <label>摘要模型 ID<input value={settings.summaryModel} onChange={(event) => setSettings((current) => ({ ...current, summaryModel: event.target.value }))} /></label>
        <label>整理輸出語言<select value={settings.summaryOutputLanguage} onChange={(event) => setSettings((current) => ({ ...current, summaryOutputLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label>
        <label><input type="checkbox" checked={settings.summaryIncludeTranslation} onChange={(event) => setSettings((current) => ({ ...current, summaryIncludeTranslation: event.target.checked }))} />每個重點另產出翻譯</label>
        <label>Markdown 整理模板<textarea value={settings.summaryTemplate} onChange={(event) => setSettings((current) => ({ ...current, summaryTemplate: event.target.value }))} /></label>
        {window.s2t && <div className="api-key-row"><label>摘要 API key<input type="password" autoComplete="off" value={summaryKeyDraft} onChange={(event) => setSummaryKeyDraft(event.target.value)} /></label><button className="secondary" onClick={() => void saveTextServiceKey('summary', summaryKeyDraft, () => setSummaryKeyDraft(''))}>儲存 API key</button></div>}
        <p className="hint">摘要會依此 Markdown 模板從 final 逐字稿生成，可在歷史紀錄按 ☷ 重新整理。</p>
      </div>}
      {settingsCategory === 'speakers' && <div className="text-service-settings">
        <p className="eyebrow">自動講者分離 API</p>
        <label>講者分離 endpoint<input type="url" placeholder="https://host.example/v1/audio/diarizations" value={settings.diarizationEndpoint} onChange={(event) => setSettings((current) => ({ ...current, diarizationEndpoint: event.target.value }))} /></label>
        <label>講者分離 model ID<input value={settings.diarizationModel} placeholder="speaker-diarization-model" onChange={(event) => setSettings((current) => ({ ...current, diarizationModel: event.target.value }))} /></label>
        {window.s2t && <div className="api-key-row"><label>講者分離 API key<input type="password" autoComplete="off" value={diarizationKeyDraft} onChange={(event) => setDiarizationKeyDraft(event.target.value)} /></label><button className="secondary" onClick={() => void saveTextServiceKey('diarization', diarizationKeyDraft, () => setDiarizationKeyDraft(''))}>儲存 API key</button></div>}
        <p className="hint">在「記錄」按「自動識別講者」後，App 會送完整 WAV。服務需回傳 `segments`、`diarization` 或 `exclusive_diarization`，每項含 `start/end/speaker`（秒）或 `start_ms/end_ms/speaker`。本機 sherpa-onnx：啟動 `npm run web:serve` 後填入 `http://127.0.0.1:8787/api/diarizations`，model 填 `sherpa-onnx-speaker-diarization`，不需要 API key。</p>
      </div>}
      {settingsCategory === 'app' && <><div className="text-service-settings"><p className="eyebrow">外觀</p><label>主題<select value={settings.theme} onChange={(event) => setSettings((current) => ({ ...current, theme: event.target.value as 'system' | 'light' | 'dark' }))}><option value="system">跟隨系統</option><option value="light">淺色</option><option value="dark">深色</option></select></label></div>
      {window.s2t && <div className="text-service-settings"><p className="eyebrow">Electron 儲存位置</p><label>預設保存至<select value={settings.storageLocation} onChange={(event) => setSettings((current) => ({ ...current, storageLocation: event.target.value as 'local' | 'remote' }))}><option value="local">本機</option><option value="remote">遠端 Storage</option></select></label><p className="hint">新紀錄依此設定保存；載入時永遠合併本機與遠端紀錄。</p></div>}</>}
      <button className="primary" onClick={saveSettings}>儲存設定</button>{settingsSaved && <span className="saved">已儲存</span>}
    </section>
  )

if (isFloatingCaptionWindow) {
    return <main className="floating-caption" aria-live="polite"><header><span>即時字幕</span><div><button className="text-button" onClick={toggleFloatingCaptionFullscreen}>{floatingCaptionFullscreen ? '退出全螢幕' : '全螢幕'}</button><button className="text-button" onClick={closeFloatingCaptions}>關閉</button></div></header><div className="floating-caption-content"><p>{floatingCaptionText}</p></div></main>
  }

return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">S2T UI</p>
          <h1>即時語音字幕</h1>
        </div>
        <div className="header-account"><span className={`status ${captureState === 'recording' || captureState === 'paused' ? 'active' : ''}`}>{status}</span><button className="menu-toggle" aria-label="開啟功能選單" aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)}>☰</button></div>
      </header>
      {menuOpen && <><button className="menu-backdrop" aria-label="關閉功能選單" onClick={() => setMenuOpen(false)} /><aside className="app-menu" aria-label="功能選單"><div className="app-menu-header"><div><p className="eyebrow">S2T UI</p><h2>功能選單</h2></div><button className="text-button" onClick={() => setMenuOpen(false)}>關閉</button></div><p className="menu-section">工作區</p>{([{ id: 'live', icon: '◉', label: '即時字幕' }, { id: 'history', icon: '▤', label: '記錄' }, { id: 'import', icon: '↥', label: '匯入檔案' }] as const).map((item) => <button key={item.id} className={view === item.id ? 'menu-item active' : 'menu-item'} onClick={() => { setView(item.id); setMenuOpen(false) }}><span>{item.icon}</span>{item.label}</button>)}<p className="menu-section">管理</p>{([{ id: 'models', icon: '◇', label: '模型列表' }, { id: 'voiceprints', icon: '◉', label: '聲紋管理' }, { id: 'settings', icon: '⚙', label: '設定' }] as const).map((item) => <button key={item.id} className={view === item.id ? 'menu-item active' : 'menu-item'} onClick={() => { setView(item.id); setMenuOpen(false) }}><span>{item.icon}</span>{item.label}</button>)}{view === 'live' && <><p className="menu-section">即時工具</p><button className="menu-item" onClick={() => { setDrawer('settings'); setMenuOpen(false) }}><span>⚙</span>快速設定</button><button className="menu-item" onClick={() => { setDrawer('export'); setMenuOpen(false) }}><span>↓</span>匯出與摘要</button></>}<div className="menu-account"><span>{user.NT}</span><small>{user.Department}</small><button className="menu-item menu-logout" onClick={() => void onLogout()}><span>↪</span>登出</button></div></aside></>}
      {modelDialogOpen && <div className="transcript-modal-backdrop" role="presentation" onMouseDown={() => setModelDialogOpen(false)}><section className="transcript-modal model-dialog" role="dialog" aria-modal="true" aria-label="註冊模型" onMouseDown={(event) => event.stopPropagation()}><header><div><p className="eyebrow">MODEL REGISTRATION</p><h2>註冊 ASR 模型</h2></div><button className="text-button" onClick={() => setModelDialogOpen(false)}>關閉</button></header><div className="model-actions"><input value={newModelName} placeholder="模型顯示名稱" onChange={(event) => setNewModelName(event.target.value)} /><input type="url" value={newModelEndpoint} placeholder={newModelUsesBuiltin ? 'https://host.example 或完整 ASR URL' : 'https://host.example（自動轉為 wss://…/v1/realtime）'} onChange={(event) => setNewModelEndpoint(event.target.value)} /><input value={newModelId} placeholder="model name / model ID" onChange={(event) => setNewModelId(event.target.value)} /><input type="password" autoComplete="off" value={newModelApiKey} placeholder="API key（Electron 加密保存）" onChange={(event) => setNewModelApiKey(event.target.value)} /><label className="model-transport-toggle"><input type="checkbox" checked={newModelUsesBuiltin} onChange={(event) => setNewModelUsesBuiltin(event.target.checked)} />用途：ASR／使用內建分段轉錄</label><button className="primary" onClick={() => { void addModelProfile(); setModelDialogOpen(false) }}>註冊模型</button></div></section></div>}
      <div className={`app-layout ${view === 'live' ? 'live-layout' : ''}`}>

        {view === 'live' && drawer === 'settings' && <aside className="settings-sidebar quick-settings" style={{ transform: `translate(${quickSettingsOffset.x}px, ${quickSettingsOffset.y}px)` }} aria-label="快速設定"><div className="quick-settings-handle" onPointerDown={startQuickSettingsDrag}><div><p className="eyebrow">QUICK SETTINGS</p><h2>快速設定</h2></div><span aria-hidden="true">⠿</span></div><label>來源語言<select value={settings.sourceLanguage} onChange={(event) => setSettings((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="auto">自動偵測</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option><option value="de-DE">Deutsch</option></select></label><label><input type="checkbox" checked={settings.translationEnabled} onChange={(event) => setSettings((current) => ({ ...current, translationEnabled: event.target.checked }))} />啟用翻譯</label><label>翻譯目標<select value={settings.targetLanguage} onChange={(event) => setSettings((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label><label>翻譯策略<select value={settings.translationStrategy} onChange={(event) => setSettings((current) => ({ ...current, translationStrategy: event.target.value as 'realtime' | 'sentence' }))}><option value="realtime">即時逐段</option><option value="sentence">完整句子</option></select></label><label>停頓斷句：{settings.vadConfig.minSilenceMs} ms<input type="range" min="100" max="5000" step="50" value={settings.vadConfig.minSilenceMs} onChange={(event) => setSettings((current) => ({ ...current, vadConfig: { ...current.vadConfig, minSilenceMs: Number(event.target.value) } }))} /></label><label>ASR 模型<select value={settings.selectedModelId} onChange={(event) => setSettings((current) => ({ ...current, selectedModelId: event.target.value }))}>{settings.modelProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label>翻譯模型<select value={settings.selectedTranslationModelId} onChange={(event) => selectTranslationProfile(event.target.value)}><option value="none">未選擇翻譯模型</option>{settings.translationProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><p className="hint">拖曳標題可調整位置；設定在下一段音訊與下一次翻譯請求生效。</p><button className="secondary" onClick={() => setView('settings')}>開啟完整設定</button></aside>}
        <section className="workspace-content">{workspace}</section>
        {view === 'live' && drawer === 'export' && <aside className="export-sidebar" aria-label="字幕匯出"><div><p className="eyebrow">EXPORT</p><h2>字幕匯出</h2></div><button className="secondary" onClick={() => exportTranscript('vtt')}>下載 VTT</button><button className="secondary" onClick={() => exportTranscript('csv')}>下載 CSV</button><button className="secondary" onClick={() => void copyTranscript(visibleTranscripts)}>複製逐字稿</button><button className="secondary" onClick={() => void createSummary()}>產生會議紀錄</button></aside>}
        {view === 'live' && <div className="drawer-rail" aria-label="側欄切換"><button aria-expanded={drawer === 'settings'} onClick={() => setDrawer((current) => current === 'settings' ? null : 'settings')}>設定</button><button aria-expanded={drawer === 'export'} onClick={() => setDrawer((current) => current === 'export' ? null : 'export')}>匯出</button></div>}
      </div>
    </main>
  )
}
