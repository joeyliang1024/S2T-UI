import { type Dispatch, type ReactElement, type SetStateAction } from 'react'
import { type SavedSession, type Settings } from '../../../shared/types'
import { transcriptSignature } from '../services/summary-plan'
import { MarkdownSummary } from './MarkdownSummary'

type Props = {
  ui: (key: string) => string
  sessions: SavedSession[]
  settings: Settings
  setSettings: Dispatch<SetStateAction<Settings>>
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
  copySummary: (text: string) => Promise<void>
  downloadSummary: (text: string) => void
}

/** The summary page is intentionally isolated from the shell so its state and output rules stay local. */
export function SummaryWorkspace(props: Props): ReactElement {
  const { ui, sessions, settings, setSettings, sessionId, setSessionId, isCreatingTemplate, setIsCreatingTemplate, templateName, setTemplateName, templateContent, setTemplateContent, selectTemplate, addTemplate, openSettings, summarizeSession, copySummary, downloadSummary } = props
  const session = sessions.find((entry) => entry.id === sessionId) ?? null
  const outdated = Boolean(session?.summary && (!session.summarySourceSignature || session.summarySourceSignature !== transcriptSignature(session.transcript) || (session.summarySourceVersionId && session.summarySourceVersionId !== session.activeAudioVersionId)))
  return <section className="page-panel summary-workspace">
    <div className="page-title"><div><p className="eyebrow">SUMMARY</p><h2>{ui('summaryTitle')}</h2></div></div>
    <div className="summary-workspace-grid">
      <section className="summary-setup">
        <label>{ui('selectRecord')}<select value={sessionId ?? ''} onChange={(event) => setSessionId(event.target.value || null)}><option value="">{ui('chooseHistoryRecord')}</option>{sessions.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {new Date(entry.createdAt).toLocaleDateString(settings.uiLanguage)}</option>)}</select></label>
        <label>{ui('summaryTemplate')}<select value={isCreatingTemplate ? 'custom' : settings.selectedSummaryTemplateId} onChange={(event) => { if (event.target.value === 'custom') { setIsCreatingTemplate(true); setTemplateName(''); setTemplateContent(['# ' + ui('summaryTitle'), '', '## ' + ui('keyPoints'), '- ', '', '## ' + ui('decisions'), '- ', '', '## ' + ui('actionItems'), '- '].join(String.fromCharCode(10))) } else { setIsCreatingTemplate(false); selectTemplate(event.target.value) } }}><option value="custom">{ui('customTemplate')}</option>{settings.summaryTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
        {isCreatingTemplate && <div className="summary-custom-template"><label>{ui('templateName')}<input value={templateName} placeholder={ui('templateNamePlaceholder')} onChange={(event) => setTemplateName(event.target.value)} /></label><label>{ui('markdownTemplate')}<textarea value={templateContent} onChange={(event) => setTemplateContent(event.target.value)} /></label><button className="secondary" onClick={addTemplate}>{ui('saveCustomTemplate')}</button></div>}
        <label>{ui('outputLanguage')}<select value={settings.summaryOutputLanguage} onChange={(event) => setSettings((current) => ({ ...current, summaryOutputLanguage: event.target.value }))}><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="de">Deutsch</option></select></label>
        <label className="summary-translation-option"><input type="checkbox" checked={settings.summaryIncludeTranslation} onChange={(event) => setSettings((current) => ({ ...current, summaryIncludeTranslation: event.target.checked }))} /> {ui('includeTranslation')}</label>
        <div className="summary-template-preview"><span>{ui('currentTemplate')}</span><pre>{isCreatingTemplate ? templateContent : settings.summaryTemplate}</pre></div>
        <button className="secondary" onClick={openSettings}>{ui('manageTemplates')}</button>
        <button className="primary" disabled={!session?.transcript.trim()} onClick={() => session && void summarizeSession(session)}>{session?.summary === '正在產生摘要…' ? ui('generating') : session?.summary ? ui('regenerateSummary') : ui('generateSummary')}</button>
      </section>
      <section className="summary-result"><div className="summary-result-heading"><div><p className="eyebrow">{ui('formattedOutput').toUpperCase()}</p><h3>{session ? session.title : ui('notSelected')}</h3>{outdated && <p className="summary-stale">{ui('summaryOutdated')}</p>}</div>{session?.summary && session.summary !== '正在產生摘要…' && <div className="summary-actions"><button className="text-button" onClick={() => void copySummary(session.summary!)}>▣ {ui('copy')}</button><button className="text-button" onClick={() => downloadSummary(session.summary!)}>↓ {ui('exportMarkdown')}</button></div>}</div>{session?.summary === '正在產生摘要…' ? <div className="empty compact"><h2>{ui('summaryGeneratingTitle')}</h2><p>{ui('summaryGeneratingHint')}</p></div> : session?.summary ? <MarkdownSummary text={session.summary} /> : <div className="empty compact"><h2>{ui('preparingSummary')}</h2><p>{ui('summaryReadyHint')}</p></div>}</section>
    </div>
  </section>
}
