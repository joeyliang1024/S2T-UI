import { StudioArtwork } from '../../../shared/ui/StudioArtwork'
import { type Dispatch, type ReactElement, type SetStateAction, useEffect, useRef, useState } from 'react'
import { type SavedSession, type Settings } from '../../../shared/types'
import { resolveUiLanguage } from '../../../shared/i18n/index'
import { languageName, supportedTargetLanguages } from '../../../shared/services/settings'
import { resolveTranslationTarget } from '../../translation/domain/policy'
import { makeTranscriptText } from '../../../shared/services/transcript'
import { MarkdownSummary } from './MarkdownSummary'

type Props = {
  generatingIds: string[]
  ui: (key: string) => string
  sessions: SavedSession[]
  settings: Settings
  sessionId: string | null
  setSessionId: Dispatch<SetStateAction<string | null>>
  selectTemplate: (id: string) => void
  openSettings: () => void
  summarizeSession: (session: SavedSession, targetLanguage?: string) => Promise<void>
  cancelSummary: (sessionId: string) => void
  translateSummary: (session: SavedSession, targetLanguage?: string, signal?: AbortSignal) => Promise<void>
  copySummary: (text: string) => Promise<void>
  openSummaryDownload: (text: string, title: string) => void
}

import { recordJourney } from '../../../shared/services/usage-journey'

/** The summary page is intentionally isolated from the shell so its state and output rules stay local. */
export function SummaryWorkspace(props: Props): ReactElement {
  const { ui, sessions, settings, sessionId, setSessionId, selectTemplate, openSettings, summarizeSession, cancelSummary, translateSummary, copySummary, openSummaryDownload } = props
  const session = sessions.find((entry) => entry.id === sessionId) ?? null
  const [summaryTab, setSummaryTab] = useState<'original' | 'translation'>('original')
  const [translating, setTranslating] = useState(false)
  const [translationError, setTranslationError] = useState<string | null>(null)
  const [translationTarget, setTranslationTarget] = useState<string | null>(null)
  const requestRef = useRef(0)
  const translationAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    requestRef.current += 1
    setSummaryTab('original')
    setTranslating(false)
    setTranslationError(null)
    setTranslationTarget(null)
    return () => { requestRef.current += 1; translationAbort.current?.abort(); translationAbort.current = null }
  }, [sessionId])
  const systemSource = ({ 'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', en: 'en-US', ja: 'ja-JP', de: 'de-DE' } as const)[resolveUiLanguage('system')]
  const activeTarget = translationTarget ?? resolveTranslationTarget(systemSource, settings.targetLanguage)
  const hasCurrentTranslation = Boolean(session?.summaryTranslation && session.summaryTranslationTargetLanguage === activeTarget)
  const runTranslation = (target = activeTarget): void => {
    if (!session?.summary || session.summaryState === 'generating' || props.generatingIds.includes(session.id) || translating || translationAbort.current) return
    const request = ++requestRef.current
    const abort = new AbortController()
    translationAbort.current = abort
    setTranslating(true)
    setTranslationError(null)
    void translateSummary(session, target, abort.signal)
      .catch((error: unknown) => {
        if (requestRef.current === request) setTranslationError(error instanceof Error ? error.message : ui('summaryTranslationFailed'))
      })
      .finally(() => { if (translationAbort.current === abort) translationAbort.current = null; if (requestRef.current === request) setTranslating(false) })
  }
  // Translation only starts from an explicit button click, never on tab open
  // or target-language change; switching the target supersedes any in-flight
  // request so the trigger button appears immediately.
  const openTranslationTab = (): void => {
    setSummaryTab('translation')
  }
  const changeTranslationTarget = (value: string): void => {
    requestRef.current += 1
    translationAbort.current?.abort(); translationAbort.current = null
    setTranslating(false)
    setTranslationError(null)
    setTranslationTarget(value)
  }
  const journeyContent = (session?.summary?.trim() || session?.summaryTranslation?.trim()) && session.summaryState !== 'generating' ? session.id : null
  useEffect(() => { if (journeyContent) recordJourney('L3') }, [journeyContent])
  const activeText = summaryTab === 'translation' ? (hasCurrentTranslation && !translating && !translationError ? session?.summaryTranslation ?? '' : '') : session?.summary ?? ''
  return <section className="page-panel summary-workspace">
    <div className="page-title"><div><p className="eyebrow">{ui('eyebrowSummary')}</p><h2>{ui('summaryTitle')}</h2></div><StudioArtwork variant="summary" className="page-art" /></div>
    <div className="summary-workspace-grid">
      <section className="summary-setup">
        <label>{ui('selectRecord')}<select value={sessionId ?? ''} onChange={(event) => setSessionId(event.target.value || null)}><option value="">{ui('chooseHistoryRecord')}</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {new Date(entry.createdAt).toLocaleDateString(resolveUiLanguage(settings.uiLanguage))}</option>)}</select></label>
        <label>{ui('summaryTemplate')}<select value={settings.selectedSummaryTemplateId} onChange={event => selectTemplate(event.target.value)}>{settings.summaryTemplates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
        <div className="summary-template-preview"><span>{ui('currentTemplate')}</span><pre>{settings.summaryTemplate}</pre></div>
        <button className="secondary" onClick={openSettings}>{ui('manageTemplates')}</button>
        {session?.processingError && <p role="status">{session.processingError}</p>}
        {session?.summaryError && <p className="summary-translation-error" role="alert">{session.summaryError}</p>}
        {translating ? <button className="secondary" onClick={() => { requestRef.current += 1; translationAbort.current?.abort(); translationAbort.current = null; setTranslating(false); setTranslationError(null) }}>{ui('cancelSummary')}</button> : session?.summaryState === 'generating' || (session && props.generatingIds.includes(session.id))
          ? <button className="secondary" onClick={() => session && cancelSummary(session.id)}>{ui('cancelSummary')}</button>
          : <button className="primary" disabled={!session || !(session.transcript.trim() || makeTranscriptText(session.segments).trim()) || session.processingState === 'running' || translating} onClick={() => { if (!session) return; if (summaryTab === 'translation' && session.summary) runTranslation(); else void summarizeSession(session, summaryTab === 'translation' ? activeTarget : undefined) }}>{ui('generateSummary')}</button>}
      </section>
      <section className="summary-result"><div className="summary-result-heading"><div><p className="eyebrow">{ui('formattedOutput').toUpperCase()}</p><h3>{session ? session.title : ui('notSelected')}</h3></div>{activeText && <div className="summary-actions"><button className="text-button" onClick={() => void copySummary(activeText)}>▣ {ui('copy')}</button><button className="text-button" onClick={() => openSummaryDownload(activeText, session?.title ?? ui('summaryTitle'))}>↓ {ui('download')}</button></div>}</div>{session?.summaryState === 'generating' && <p className="summary-translation-status" role="status">{ui('summaryGeneratingTitle')} {ui('summaryGeneratingHint')}</p>}<div className="summary-toolbar"><div className="summary-tabs" role="tablist"><button type="button" role="tab" aria-selected={summaryTab === 'original'} onClick={() => setSummaryTab('original')}>{ui('sourceText')}</button><button type="button" role="tab" aria-selected={summaryTab === 'translation'} onClick={openTranslationTab}>{ui('translateSummary')}</button></div>
        {summaryTab === 'original' && <p className="summary-language-hint">{ui(window.s2t ? 'summaryLanguageHint' : 'summaryBrowserLanguageHint')}</p>}
        {summaryTab === 'translation' && <label className="summary-target-language">{ui('translationLanguage')}<select value={activeTarget} disabled={translating || Boolean(session && props.generatingIds.includes(session.id))} onChange={event => changeTranslationTarget(event.target.value)}>{supportedTargetLanguages.map(language => <option key={language} value={language}>{languageName(language)}</option>)}</select></label>}</div>
        {translating && summaryTab === 'translation' ? <p className="summary-translation-status" role="status">{ui('summaryTranslating')}</p> : translationError && summaryTab === 'translation' ? <p className="summary-translation-error" role="alert">{translationError}</p> : activeText ? <MarkdownSummary text={activeText} /> : session?.summaryState === 'generating' ? <div className="empty compact"><h2>{ui('summaryGeneratingTitle')}</h2><p>{ui('summaryGeneratingHint')}</p></div> : <div className="empty compact summary-studio-empty"><h2>{ui('preparingSummary')}</h2><p>{ui('summaryReadyHint')}</p></div>}</section>
    </div>
  </section>
}
