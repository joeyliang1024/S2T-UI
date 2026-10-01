import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react'
import { interfaceTranslate } from '../../../../shared/i18n'
import type { Settings, View } from '../../../../shared/types'
import { parseGlossaryJson } from '../../services/glossary-json'
import type { AppController } from '../../hooks/useAppController'

type SettingsCategory = 'asr' | 'translation' | 'summary' | 'app'

const serializeSettings = (value: Settings): string => JSON.stringify(value)

interface SettingsCardProps {
  eyebrow: string
  title: string
  aside?: ReactNode
  className?: string
  children: ReactNode
}

function SettingsCard({ eyebrow, title, aside, className, children }: SettingsCardProps): ReactElement {
  return (
    <section className={className ? `settings-card ${className}` : 'settings-card'}>
      <header className="settings-card-header">
        <div className="settings-card-heading"><p className="eyebrow">{eyebrow}</p><h3>{title}</h3></div>
        {aside && <div className="settings-card-aside">{aside}</div>}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  )
}

interface ToggleRowProps {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
}

function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps): ReactElement {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-row-text"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    </label>
  )
}

function UnsavedLeaveDialog({ title, message, discardLabel, keepLabel, onDiscard, onKeepEditing }: { title: string; message: string; discardLabel: string; keepLabel: string; onDiscard: () => void; onKeepEditing: () => void }): ReactElement {
  return (
    <div className="transcript-modal-backdrop settings-leave-backdrop" role="presentation" onMouseDown={onKeepEditing}>
      <section className="settings-leave-dialog" role="alertdialog" aria-modal="true" aria-labelledby="settings-leave-title" onMouseDown={(event) => event.stopPropagation()}>
        <p className="eyebrow">SETTINGS</p>
        <h2 id="settings-leave-title">{title}</h2>
        <p className="hint">{message}</p>
        <div className="settings-leave-actions">
          <button className="text-button" onClick={onKeepEditing}>{keepLabel}</button>
          <button className="danger" onClick={onDiscard}>{discardLabel}</button>
        </div>
      </section>
    </div>
  )
}

export interface SettingsViewProps {
  controller: AppController
  settingsReturnView: Exclude<View, 'settings'>
  onNavigate: (target: View) => void
  leaveRequest: { target: View; nonce: number } | null
  onLeaveResolved: (target: View) => void
  onLeaveDismissed: () => void
  onDirtyChange: (dirty: boolean) => void
  summaryTemplate: {
    select: (id: string) => void
    remove: () => void
  }
}

export function SettingsView({ controller, settingsReturnView, onNavigate, leaveRequest, onLeaveResolved, onLeaveDismissed, onDirtyChange, summaryTemplate }: SettingsViewProps): ReactElement {
  const {
    settings, setSettings, setStatus, saveSettings, settingsSaved, denoiseApplied,
    browserRecordingStorage, remoteSessionSyncState, storageHealth, audioMigrationStatus,
    storageCompensations, storageOrphanAudio, sileroVadAvailable, modelHealth,
    retryRemoteSessionSync, retryStorageCompensations, cleanOrphanAudio
  } = controller
  const [category, setCategory] = useState<SettingsCategory>('asr')
  const [glossarySearch, setGlossarySearch] = useState('')
  const [newGlossaryTerm, setNewGlossaryTerm] = useState('')
  const [dirty, setDirty] = useState(false)
  const sileroHealth = modelHealth['managed-silero-vad']
  const sileroHealthLabel = sileroHealth?.state === 'healthy' ? '健康' : sileroHealth?.state === 'degraded' ? '降級' : sileroHealth?.state === 'unhealthy' ? '失敗' : '未確認'
  // Last saved (or mounted) snapshot: comparison baseline and revert target.
  const savedSnapshotRef = useRef<string>(serializeSettings(settings))
  const savedFlagRef = useRef(false)
  // Only user edits freeze the baseline. System-side hydration (remote settings,
  // model registry, glossary, Silero availability, …) can land at any time and
  // must keep re-baselining instead of being reported as unsaved changes.
  const userEditedRef = useRef(false)
  const update = (updater: (current: Settings) => Settings): void => {
    userEditedRef.current = true
    setSettings(updater)
  }

  useEffect(() => {
    const serialized = serializeSettings(settings)
    if (!userEditedRef.current) {
      savedSnapshotRef.current = serialized
      setDirty(false)
      onDirtyChange(false)
      return
    }
    const next = serialized !== savedSnapshotRef.current
    setDirty(next)
    onDirtyChange(next)
  }, [settings, onDirtyChange])
  useEffect(() => {
    if (settingsSaved && !savedFlagRef.current) { savedSnapshotRef.current = serializeSettings(settings); userEditedRef.current = false; setDirty(false); onDirtyChange(false) }
    savedFlagRef.current = settingsSaved
  }, [settingsSaved, settings, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const ui = (key: Parameters<typeof interfaceTranslate>[1]): string => interfaceTranslate(settings.uiLanguage, key)

  const glossaryEntries = settings.glossary.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).map((value, index) => ({ value, index }))
  const replaceGlossaryEntry = (index: number, value: string): void => update((current) => {
    const entries = current.glossary.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    if (value.trim()) entries[index] = value.trim(); else entries.splice(index, 1)
    return { ...current, glossary: entries.join('\n') }
  })
  const addGlossaryEntry = (): void => {
    const value = newGlossaryTerm.trim()
    if (!value) return
    update((current) => ({ ...current, glossary: [current.glossary.trim(), value].filter(Boolean).join('\n') }))
    setNewGlossaryTerm('')
  }
  const importGlossaryJson = async (file: File | null): Promise<void> => {
    if (!file) return
    try {
      if (file.size > 1024 * 1024) throw new Error(ui('glossaryFileTooLarge'))
      const glossaryImport = parseGlossaryJson(await file.text())
      const glossary = glossaryImport.entries
      update((current) => ({ ...current, glossary: [...current.glossary.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean), ...glossary].filter((entry, index, all) => all.indexOf(entry) === index).join('\n') }))
      setStatus(`已載入 ${glossary.length} 筆 JSON 術語${glossaryImport.invalidEntries ? `；略過 ${glossaryImport.invalidEntries} 筆無效資料` : ''}${glossaryImport.ignoredDuplicates ? `；略過 ${glossaryImport.ignoredDuplicates} 筆重複或超出上限資料` : ''}；請儲存設定。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'invalid-json') setStatus(ui('glossaryJsonUnreadable'))
      else if (message === 'invalid-root') setStatus(ui('glossaryJsonRootInvalid'))
      else if (message === 'empty-glossary') setStatus('找不到可用術語；請使用 {「術語」:「指定譯法」} 或 [{"term":"術語","translation":"指定譯法"}] 格式。')
      else setStatus(message || ui('glossaryJsonLoadFailed'))
    }
  }
  const setDenoiseEnabled = (enabled: boolean): void => {
    update((current) => ({ ...current, denoiseEnabled: enabled }))
    if (controller.captureState === 'recording' || controller.captureState === 'paused') setStatus('降噪偏好已保存；需切換麥克風或下次開始收音才會建立新的音源 stream。')
  }
  const revertChanges = (): void => { userEditedRef.current = false; setSettings(JSON.parse(savedSnapshotRef.current) as Settings); setDirty(false); onDirtyChange(false) }

  const appStorageDashboard = (): ReactElement => (
    <section className="settings-health-dashboard" aria-label={ui('remoteStorage')}>
      <article className="storage-health-card remote-storage-card">
        <div className="storage-health-heading"><span className="eyebrow">REMOTE STORAGE</span><span className={`sync-state ${remoteSessionSyncState}`}>{remoteSessionSyncState === 'ready' ? ui('remoteSyncReady') : remoteSessionSyncState === 'syncing' ? ui('remoteSyncing') : ui('remoteSyncPaused')}</span></div>
        {storageHealth ? <div className="storage-adapter-list"><span>Blob <strong>{storageHealth.mode.blob}</strong></span><span>Config <strong>{storageHealth.mode.config}</strong></span><span>Vector <strong>{storageHealth.mode.vector}</strong></span><span>Schema <strong>{storageHealth.schemaVersion}</strong></span></div> : <p>{ui('storageHealthUnavailable')}</p>}
        {remoteSessionSyncState === 'syncing' && <progress className="indeterminate-progress" />}
      </article>
      <article className="storage-health-card queue-health-card">
        <div className="storage-health-heading"><span className="eyebrow">WORK QUEUE</span></div>
        <div className="queue-metrics">
          {([
            ['queueMigrated', '✓', audioMigrationStatus?.copied, 'complete'],
            ['queueRetry', '↻', audioMigrationStatus?.pending, 'pending'],
            ['queueAudio', '♫', storageCompensations?.audioPending, 'pending'],
            ['queueVoiceprint', '◎', storageCompensations?.voiceprintPending, 'pending'],
            ['queueOrphan', '◇', storageOrphanAudio, 'neutral']
          ] as const).map(([label, icon, count, tone]) => <div key={label} className={`queue-metric ${count ? tone : 'neutral'}`}><span className="queue-metric-icon" aria-hidden="true">{icon}</span><strong>{count ?? '—'}</strong><span className="queue-metric-label">{ui(label)}</span></div>)}
        </div>
      </article>
    </section>
  )

  const categories: ReadonlyArray<{ id: SettingsCategory; label: string }> = [
    { id: 'asr', label: ui('transcriptionVad') },
    { id: 'translation', label: ui('translationGlossary') },
    { id: 'summary', label: ui('summaryTemplates') },
    { id: 'app', label: ui('application') }
  ]

  const filteredGlossaryEntries = glossaryEntries.filter((entry) => entry.value.toLocaleLowerCase().includes(glossarySearch.trim().toLocaleLowerCase()))

  return (
    <section className="page-panel settings-panel">
      <div className="page-title"><div><p className="eyebrow">SETTINGS</p><h2>{ui('settingsTitle')}</h2></div></div>
      <nav className="settings-category-nav" aria-label={ui('settingsTitle')}>{categories.map((entry) => <button key={entry.id} className={category === entry.id ? 'nav-active' : ''} aria-current={category === entry.id ? 'true' : undefined} onClick={() => setCategory(entry.id)}>{entry.label}</button>)}</nav>

      {category === 'asr' && <>
        <SettingsCard eyebrow="AUDIO" title={ui('audioProcessing')}>
          <div className="toggle-list">
            <ToggleRow label={ui('enableDenoise')} checked={settings.denoiseEnabled} onChange={setDenoiseEnabled} />
            <ToggleRow label="使用 Kaiser 高品質重取樣" hint="下一次收音生效" checked={settings.kaiserResampleEnabled} onChange={(enabled) => update((current) => ({ ...current, kaiserResampleEnabled: enabled }))} />
            <p className="hint">Silero VAD 健康度：<span className={`model-health ${sileroHealth?.state ?? 'unknown'}`} title={sileroHealth?.reason ?? '尚未執行健康檢查'}><i aria-hidden="true" />{sileroHealthLabel}</span>{sileroHealth?.reason ? `－${sileroHealth.reason}` : ''}</p>
            {sileroVadAvailable === true && <ToggleRow label="使用 Silero VAD" hint="Web gateway CPU worker；下一次收音生效" checked={settings.sileroVadEnabled} onChange={(enabled) => update((current) => ({ ...current, sileroVadEnabled: enabled }))} />}
            {sileroVadAvailable === false && <p className="hint">Silero VAD 模型尚未載入（模型檔、checksum 或 onnxruntime-node 檢查未通過），因此不顯示啟用選項。</p>}
            <ToggleRow label="使用 dynaudnorm 音量正規化" hint="Web gateway CPU worker；下一次收音生效" checked={settings.dynaudnormEnabled} onChange={(enabled) => update((current) => ({ ...current, dynaudnormEnabled: enabled }))} />
          </div>
          <details className="help-disclosure">
            <summary>{ui('advancedHelp')}</summary>
            <p className="hint">此設定請求瀏覽器的 noiseSuppression，只影響新建或切換的麥克風 stream；保存音檔與送往 ASR 的音訊都使用同一處理後 stream。瀏覽器可能不支援此約束。</p>
            <p className="hint">{denoiseApplied === true ? ui('denoiseApplied') : denoiseApplied === false ? ui('denoiseNotApplied') : ui('denoiseUnknown')}</p>
            <p className="hint">只會套用在送往 ASR 的重取樣分支，原始錄音與聲紋 embedding 保持未正規化；開啟後會使用較高品質的 anti-alias filter。</p>
            <p className="hint">預設值採 faster-whisper 常用的 500 ms 靜音起點；Breeze HTTP 的時間戳是 App 音訊 chunk 邊界，不是模型 word timestamps。</p>
          </details>
        </SettingsCard>
      </>}

      {category === 'translation' && <>
        <SettingsCard eyebrow="LANGUAGES" title={`${ui('sourceLanguage')} / ${ui('targetLanguage')}`}>
          <div className="settings-form-grid">
            <label>{ui('sourceLanguage')}<select value={settings.sourceLanguage} onChange={(event) => update((current) => ({ ...current, sourceLanguage: event.target.value }))}><option value="auto">{ui('autoDetect')}</option><option value="zh-TW">繁體中文</option><option value="en-US">English</option><option value="ja-JP">日本語</option><option value="de-DE">Deutsch</option></select></label>
            <label>{ui('targetLanguage')}<select value={settings.targetLanguage} onChange={(event) => update((current) => ({ ...current, targetLanguage: event.target.value }))}><option value="auto">{ui('autoBidirectional')}</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label>
          </div>
        </SettingsCard>

        <SettingsCard eyebrow="TRANSLATION" title={ui('translationApi')}>
          <div className="toggle-list">
            <ToggleRow label={ui('enableTranslation')} checked={settings.translationEnabled} onChange={(enabled) => update((current) => ({ ...current, translationEnabled: enabled }))} />
          </div>
          <div className="settings-form-grid">
            <label>{ui('translationStrategy')}<select value={settings.translationStrategy} onChange={(event) => update((current) => ({ ...current, translationStrategy: event.target.value as 'realtime' | 'sentence' }))}><option value="realtime">{ui('realtimeSegment')}</option><option value="sentence">{ui('completeSentence')}</option></select></label>
            <label>{ui('loadStrategy')}<select value={settings.translationLoadStrategy} onChange={(event) => update((current) => ({ ...current, translationLoadStrategy: event.target.value as 'automatic' | 'throttled' | 'manual' }))}><option value="automatic">{ui('automaticQueue')}</option><option value="throttled">{ui('throttledTranslation')}</option><option value="manual">{ui('manualTranslation')}</option></select></label>
          </div>
        </SettingsCard>

        <SettingsCard eyebrow="GLOSSARY" title={ui('glossary')}>
          <label className="settings-search-field">{ui('searchGlossary')}<input value={glossarySearch} placeholder={ui('glossarySearchPlaceholder')} onChange={(event) => setGlossarySearch(event.target.value)} /></label>
          <div className="glossary-editor">{filteredGlossaryEntries.map((entry) => <div key={entry.index}><input defaultValue={entry.value} aria-label={ui('glossaryTerm')} onBlur={(event) => replaceGlossaryEntry(entry.index, event.currentTarget.value)} /><button className="text-button danger" aria-label={ui('deleteGlossary')} onClick={() => replaceGlossaryEntry(entry.index, '')}>{ui('deleteGlossary')}</button></div>)}{glossaryEntries.length === 0 && <p className="hint">{ui('noGlossary')}</p>}{glossaryEntries.length > 0 && filteredGlossaryEntries.length === 0 && <p className="hint">{ui('noGlossary')}</p>}<div className="glossary-add-row"><input value={newGlossaryTerm} aria-label={ui('addGlossary')} placeholder={ui('glossaryExample')} onChange={(event) => setNewGlossaryTerm(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addGlossaryEntry() } }} /><button className="secondary" onClick={addGlossaryEntry}>{ui('addGlossary')}</button></div></div>
          <label className="glossary-json-import">{ui('loadGlossaryJson')}<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ''; void importGlossaryJson(file) }} /></label>
          <details className="help-disclosure"><summary>{ui('advancedHelp')}</summary><p className="hint">支援 {"{「術語」:「指定譯法」}"} 或 [{"{\"term\":\"術語\",\"translation\":\"指定譯法\"}"}]；載入後請儲存設定。</p></details>
        </SettingsCard>
      </>}

      {category === 'summary' && (
        <SettingsCard eyebrow="TEMPLATES" title={ui('savedTemplates')} className="summary-template-manager" aside={<button className="text-button danger" onClick={summaryTemplate.remove}>{ui('deleteCurrentTemplate')}</button>}>
          <p className="settings-card-sub">{ui('templateManagementHint')}</p>
          <div className="summary-template-body">
            <section className="saved-template-list" aria-label={ui('savedTemplates')}>
              <span>{ui('currentTemplate')}</span>
              <div>{settings.summaryTemplates.map((template) => <button key={template.id} className={template.id === settings.selectedSummaryTemplateId ? 'active' : ''} aria-current={template.id === settings.selectedSummaryTemplateId ? 'true' : undefined} onClick={() => summaryTemplate.select(template.id)}><span>▤</span>{template.name}</button>)}</div>
            </section>
            <div className="summary-template-preview"><span>{ui('templatePreview')}</span><pre>{settings.summaryTemplate}</pre></div>
          </div>
        </SettingsCard>
      )}

      {category === 'app' && <>
        <SettingsCard eyebrow="APPEARANCE" title={ui('interfaceDisplay')}>
          <div className="settings-form-grid">
            <label>{ui('displayLanguage')}<select value={settings.uiLanguage} onChange={(event) => update((current) => ({ ...current, uiLanguage: event.target.value as typeof current.uiLanguage }))}><option value="system">{ui('followSystem')}</option><option value="zh-TW">繁體中文</option><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label>
            <label>{ui('theme')}<select value={settings.theme} onChange={(event) => update((current) => ({ ...current, theme: event.target.value as 'system' | 'light' | 'dark' }))}><option value="system">{ui('followSystem')}</option><option value="light">{ui('light')}</option><option value="dark">{ui('dark')}</option></select></label>
          </div>
        </SettingsCard>

        <SettingsCard eyebrow="STORAGE" title={ui('application')}>
          <p className="hint">{browserRecordingStorage === 'electron' ? ui('recordingStorageElectron') : browserRecordingStorage === 'opfs' ? ui('recordingStorageOpfs') : ui('recordingStorageMemory')}</p>
          {window.s2t && <div className="settings-form-grid"><label>{ui('defaultSaveTo')}<select value={settings.storageLocation} onChange={(event) => update((current) => ({ ...current, storageLocation: event.target.value as 'local' | 'remote' }))}><option value="local">{ui('local')}</option><option value="remote">{ui('remoteStorage')}</option></select></label></div>}
          {window.s2t && <p className="hint">{ui('storageLocationHint')}</p>}
        </SettingsCard>

        <SettingsCard eyebrow="REMOTE" title={ui('remoteStorage')}>
          {appStorageDashboard()}
          <div className="settings-button-row">
            <button className="text-button" onClick={() => void retryRemoteSessionSync()}>{ui('retryRemoteSync')}</button>
            <button className="text-button" onClick={() => void retryStorageCompensations()}>{ui('retryStorageCompensations')}</button>
            <button className="text-button" onClick={() => void cleanOrphanAudio()}>{ui('cleanOrphanAudio')}</button>
          </div>
        </SettingsCard>
      </>}

      <footer className="settings-footer">
        <div className="settings-footer-status">
          {dirty ? <span className="unsaved-indicator" role="status">{ui('unsavedChanges')}</span> : settingsSaved ? <span className="saved" role="status">{ui('saved')}</span> : null}
        </div>
        <div className="settings-footer-actions">
          <button className="text-button" onClick={() => onNavigate(settingsReturnView)}>{ui('returnPrevious')}</button>
          <button className={dirty ? 'primary attention' : 'primary'} onClick={saveSettings}>{ui('saveSettings')}</button>
        </div>
      </footer>

      {leaveRequest && <UnsavedLeaveDialog title={ui('unsavedChanges')} message={ui('unsavedLeaveConfirm')} discardLabel={ui('discardChanges')} keepLabel={ui('keepEditing')} onDiscard={() => { revertChanges(); onLeaveResolved(leaveRequest.target) }} onKeepEditing={onLeaveDismissed} />}
    </section>
  )
}
