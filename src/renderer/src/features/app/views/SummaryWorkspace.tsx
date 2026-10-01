import { type Dispatch, type ReactElement, type SetStateAction, useEffect, useState } from 'react'
import { type SavedSession, type Settings } from '../../../shared/types'
import { resolveUiLanguage } from '../../../shared/i18n'
import { languageName, supportedTargetLanguages } from '../../../shared/services/settings'
import { resolveTranslationTarget } from '../services/translation-policy'
import { transcriptSignature } from '../services/summary-plan'
import { MarkdownSummary } from './MarkdownSummary'

type Props = {
  ui: (key: string) => string
  sessions: SavedSession[]
  settings: Settings
  sessionId: string | null
  setSessionId: Dispatch<SetStateAction<string | null>>
  isCreatingTemplate: boolean
  setIsCreatingTemplate: Dispatch<SetStateAction<boolean>>
  templateName: string
  setTemplateName: Dispatch<SetStateAction<string>>
  templateContent: string
  setTemplateContent: Dispatch<SetStateAction<string>>
  selectTemplate: (id: string) => void
  addTemplate: () => void
  openSettings: () => void
  summarizeSession: (session: SavedSession) => Promise<void>
  translateSummary: (session: SavedSession, targetLanguage?: string) => Promise<void>
  copySummary: (text: string) => Promise<void>
  openSummaryDownload: (text: string, title: string) => void
}

/** The summary page is intentionally isolated from the shell so its state and output rules stay local. */
export function SummaryWorkspace(props: Props): ReactElement {
  const { ui, sessions, settings, sessionId, setSessionId, isCreatingTemplate, setIsCreatingTemplate, templateName, setTemplateName, templateContent, setTemplateContent, selectTemplate, addTemplate, openSettings, summarizeSession, translateSummary, copySummary, openSummaryDownload } = props
  const session = sessions.find((entry) => entry.id === sessionId) ?? null
  const outdated = Boolean(session?.summary && (!session.summarySourceSignature || session.summarySourceSignature !== transcriptSignature(session.transcript) || (session.summarySourceVersionId && session.summarySourceVersionId !== session.activeAudioVersionId)))
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
    if (!session?.summary || session.summary === '正在產生摘要…' || translating) return
    setTranslating(true)
    setTranslationError(null)
    void translateSummary(session, activeTarget)
      .catch((error: unknown) => setTranslationError(error instanceof Error ? error.message : '摘要翻譯失敗'))
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
        .catch((error: unknown) => setTranslationError(error instanceof Error ? error.message : '摘要翻譯失敗'))
        .finally(() => setTranslating(false))
    }
  }
  const activeText = summaryTab === 'translation' && session?.summaryTranslation ? session.summaryTranslation : session?.summary ?? ''
  return <section className="page-panel summary-workspace">
    <div className="page-title"><div><p className="eyebrow">SUMMARY</p><h2>{ui('summaryTitle')}</h2></div></div>
    <div className="summary-workspace-grid">
      <section className="summary-setup">
        <label>{ui('selectRecord')}<select value={sessionId ?? ''} onChange={(event) => setSessionId(event.target.value || null)}><option value="">{ui('chooseHistoryRecord')}</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {new Date(entry.createdAt).toLocaleDateString(resolveUiLanguage(settings.uiLanguage))}</option>)}</select></label>
        <label>{ui('summaryTemplate')}<select value={isCreatingTemplate ? 'custom' : settings.selectedSummaryTemplateId} onChange={(event) => { if (event.target.value === 'custom') { setIsCreatingTemplate(true); setTemplateName(''); setTemplateContent(['# ' + ui('summaryTitle'), '', '## ' + ui('keyPoints'), '- ', '', '## ' + ui('decisions'), '- ', '', '## ' + ui('actionItems'), '- '].join(String.fromCharCode(10))) } else { setIsCreatingTemplate(false); selectTemplate(event.target.value) } }}><option value="custom">{ui('customTemplate')}</option>{settings.summaryTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
        {isCreatingTemplate && <div className="summary-custom-template"><label>{ui('templateName')}<input value={templateName} placeholder={ui('templateNamePlaceholder')} onChange={(event) => setTemplateName(event.target.value)} /></label><label>{ui('markdownTemplate')}<textarea value={templateContent} onChange={(event) => setTemplateContent(event.target.value)} /></label><button className="secondary" onClick={addTemplate}>{ui('saveCustomTemplate')}</button></div>}
        <p className="summary-language-hint">{ui('summaryLanguageHint')}</p>
        <div className="summary-template-preview"><span>{ui('currentTemplate')}</span><pre>{isCreatingTemplate ? templateContent : settings.summaryTemplate}</pre></div>
        <button className="secondary" onClick={openSettings}>{ui('manageTemplates')}</button>
        <button className="primary" disabled={!session?.transcript.trim()} onClick={() => session && void summarizeSession(session)}>{session?.summary === '正在產生摘要…' ? ui('generating') : session?.summary ? ui('regenerateSummary') : ui('generateSummary')}</button>
      </section>
      <section className="summary-result"><div className="summary-result-heading"><div><p className="eyebrow">{ui('formattedOutput').toUpperCase()}</p><h3>{session ? session.title : ui('notSelected')}</h3>{outdated && <p className="summary-stale">{ui('summaryOutdated')}</p>}</div>{session?.summary && session.summary !== '正在產生摘要…' && <div className="summary-actions"><button className="text-button" onClick={() => void copySummary(activeText)}>▣ {ui('copy')}</button><button className="text-button" onClick={() => openSummaryDownload(activeText, session.title)}>↓ {ui('download')}</button></div>}</div>{session?.summary === '正在產生摘要…' ? <div className="empty compact"><h2>{ui('summaryGeneratingTitle')}</h2><p>{ui('summaryGeneratingHint')}</p></div> : session?.summary ? <><div className="summary-tabs" role="tablist"><button type="button" role="tab" aria-selected={summaryTab === 'original'} onClick={() => setSummaryTab('original')}>{ui('sourceText')}</button><button type="button" role="tab" aria-selected={summaryTab === 'translation'} onClick={openTranslationTab}>{ui('translation')}</button>{summaryTab === 'translation' && <label className="summary-target-language">{ui('translationLanguage')}<select value={activeTarget} onChange={(event) => changeTranslationTarget(event.target.value)}>{supportedTargetLanguages.map((language) => <option key={language} value={language}>{languageName(language)}</option>)}</select></label>}</div>{summaryTab === 'original' || !session.summaryTranslation ? <MarkdownSummary text={session.summary} /> : translating ? <p className="summary-translation-status" role="status">{ui('summaryTranslating')}</p> : translationError ? <p className="summary-translation-error" role="alert">{translationError} <button className="text-button" onClick={() => { setTranslationError(null); runTranslation() }}>{ui('retryTranslation')}</button></p> : <MarkdownSummary text={session.summaryTranslation} />}</> : <div className="empty compact"><h2>{ui('preparingSummary')}</h2><p>{ui('summaryReadyHint')}</p></div>}</section>
    </div>
  </section>
}
