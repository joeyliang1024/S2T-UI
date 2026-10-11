import { type Dispatch, type ReactElement, type SetStateAction, useEffect, useState } from 'react'
import { type SavedSession, type Settings } from '../../../shared/types'
import { resolveUiLanguage } from '../../../shared/i18n'
import { languageName, supportedTargetLanguages } from '../../../shared/services/settings'
import { resolveTranslationTarget } from '../services/translation-policy'
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
  summarizeSession: (session: SavedSession) => Promise<void>
  translateSummary: (session: SavedSession, targetLanguage?: string) => Promise<void>
  copySummary: (text: string) => Promise<void>
  openSummaryDownload: (text: string, title: string) => void
}

/** The summary page is intentionally isolated from the shell so its state and output rules stay local. */
export function SummaryWorkspace(props: Props): ReactElement {
  const { ui, sessions, settings, sessionId, setSessionId, selectTemplate, openSettings, summarizeSession, translateSummary, copySummary, openSummaryDownload } = props
  const session = sessions.find((entry) => entry.id === sessionId) ?? null
  const [summaryTab, setSummaryTab] = useState<'original' | 'translation'>('original')
  const [translating, setTranslating] = useState(false)
  const [translationError, setTranslationError] = useState<string | null>(null)
  const [translationTarget, setTranslationTarget] = useState<string | null>(null)
  useEffect(() => {
    setSummaryTab('original')
    setTranslating(false)
    setTranslationError(null)
    setTranslationTarget(null)
  }, [sessionId])
  const systemSource = ({ 'zh-TW': 'zh-TW', 'zh-CN': 'zh-TW', en: 'en-US', ja: 'ja-JP', de: 'de-DE' } as const)[resolveUiLanguage('system')]
  const activeTarget = translationTarget ?? resolveTranslationTarget(systemSource, settings.targetLanguage)
  const runTranslation = (): void => {
    if (!session?.summary || session.summary === '正在產生摘要…' || props.generatingIds.includes(session.id) || translating) return
    setTranslating(true)
    setTranslationError(null)
    void translateSummary(session, activeTarget)
      .catch((error: unknown) => setTranslationError(error instanceof Error ? error.message : ui('summaryTranslationFailed')))
      .finally(() => setTranslating(false))
  }
  const openTranslationTab = (): void => {
    setSummaryTab('translation')
    if (session?.summary && !session.summaryTranslation && !translationError) runTranslation()
  }
  const changeTranslationTarget = (value: string): void => {
    setTranslationTarget(value)
    setTranslationError(null)
    if (session?.summary && session.summary !== '正在產生摘要…') {
      setTranslating(true)
      void translateSummary(session, value)
        .catch((error: unknown) => setTranslationError(error instanceof Error ? error.message : ui('summaryTranslationFailed')))
        .finally(() => setTranslating(false))
    }
  }
  const activeText = summaryTab === 'translation' && session?.summaryTranslation ? session.summaryTranslation : session?.summary ?? ''
  return <section className="page-panel summary-workspace">
    <div className="page-title"><div><p className="eyebrow">SUMMARY</p><h2>{ui('summaryTitle')}</h2></div></div>
    <div className="summary-workspace-grid">
      <section className="summary-setup">
        <label>{ui('selectRecord')}<select value={sessionId ?? ''} onChange={(event) => setSessionId(event.target.value || null)}><option value="">{ui('chooseHistoryRecord')}</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {new Date(entry.createdAt).toLocaleDateString(resolveUiLanguage(settings.uiLanguage))}</option>)}</select></label>
        <label>{ui('summaryTemplate')}<select value={settings.selectedSummaryTemplateId} onChange={event => selectTemplate(event.target.value)}>{settings.summaryTemplates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
        <p className="summary-language-hint">{ui('summaryLanguageHint')}</p>
        <div className="summary-template-preview"><span>{ui('currentTemplate')}</span><pre>{settings.summaryTemplate}</pre></div>
        <button className="secondary" onClick={openSettings}>{ui('manageTemplates')}</button>
        {session?.processingError && <p role="status">{session.processingError}</p>}
        {session?.summaryError && <p className="summary-translation-error" role="alert">{session.summaryError}</p>}
        <button className="primary" disabled={!session || !(session.transcript.trim() || makeTranscriptText(session.segments).trim()) || session.processingState === 'running' || props.generatingIds.includes(session.id)} onClick={() => session && void summarizeSession(session)}>{session && props.generatingIds.includes(session.id) ? ui('generating') : session?.summary ? ui('regenerateSummary') : ui('generateSummary')}</button>
      </section>
      <section className="summary-result"><div className="summary-result-heading"><div><p className="eyebrow">{ui('formattedOutput').toUpperCase()}</p><h3>{session ? session.title : ui('notSelected')}</h3></div>{session?.summary && !props.generatingIds.includes(session.id) && session.summary !== '正在產生摘要…' && <div className="summary-actions"><button className="text-button" onClick={() => void copySummary(activeText)}>▣ {ui('copy')}</button><button className="text-button" onClick={() => openSummaryDownload(activeText, session.title)}>↓ {ui('download')}</button></div>}</div>{session?.summary === '正在產生摘要…' ? <div className="empty compact"><h2>{ui('summaryGeneratingTitle')}</h2><p>{ui('summaryGeneratingHint')}</p></div> : session?.summary ? <><div className="summary-tabs" role="tablist"><button type="button" role="tab" aria-selected={summaryTab === 'original'} onClick={() => setSummaryTab('original')}>{ui('sourceText')}</button><button type="button" role="tab" disabled={Boolean(session && props.generatingIds.includes(session.id))} aria-selected={summaryTab === 'translation'} onClick={openTranslationTab}>{ui('translation')}</button>{summaryTab === 'translation' && <label className="summary-target-language">{ui('translationLanguage')}<select value={activeTarget} onChange={(event) => changeTranslationTarget(event.target.value)}>{supportedTargetLanguages.map((language) => <option key={language} value={language}>{languageName(language)}</option>)}</select></label>}</div>{summaryTab === 'original' || !session.summaryTranslation ? <MarkdownSummary text={session.summary} /> : translating ? <p className="summary-translation-status" role="status">{ui('summaryTranslating')}</p> : translationError ? <p className="summary-translation-error" role="alert">{translationError} <button className="text-button" onClick={() => { setTranslationError(null); runTranslation() }}>{ui('retryTranslation')}</button></p> : <MarkdownSummary text={session.summaryTranslation} />}</> : <div className="empty compact"><h2>{ui('preparingSummary')}</h2><p>{ui('summaryReadyHint')}</p></div>}</section>
    </div>
  </section>
}
