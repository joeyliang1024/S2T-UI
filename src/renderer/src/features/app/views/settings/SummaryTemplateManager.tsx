import { useEffect, useState } from 'react'
import type { Settings } from '../../../../shared/types'
export function SummaryTemplateManager({ settings, ui, select, remove, save }: { settings: Settings; ui: (key: string) => string; select: (id: string) => void; remove: () => void; save: (name: string, content: string, id?: string) => boolean }): React.JSX.Element {
  const selected = settings.summaryTemplates.find(template => template.id === settings.selectedSummaryTemplateId)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState(selected?.name || '')
  const [content, setContent] = useState(selected?.content || '')
  useEffect(() => { setCreating(false); setName(selected?.name || ''); setContent(selected?.content || '') }, [selected?.id, selected?.name, selected?.content])
  return <>
    <div className="summary-template-body">
      <section className="saved-template-list" aria-label={ui('savedTemplates')}><span>{ui('currentTemplate')}</span><div>{settings.summaryTemplates.map(template => <button key={template.id} className={!creating && template.id === settings.selectedSummaryTemplateId ? 'active' : ''} onClick={() => { setCreating(false); setName(template.name); setContent(template.content); select(template.id) }}><span>▤</span>{template.name}</button>)}</div><button className="secondary" onClick={() => { setCreating(true); setName(''); setContent('# ' + ui('summaryTitle') + '\n') }}>{ui('customTemplate')}</button></section>
      <div className="summary-custom-template"><label>{ui('templateName')}<input value={name} onChange={event => setName(event.target.value)} /></label><label>{ui('markdownTemplate')}<textarea value={content} onChange={event => setContent(event.target.value)} /></label><button className="secondary" onClick={() => { if (save(name, content, creating ? undefined : selected?.id)) setCreating(false) }}>{ui('saveTemplate')}</button>{!creating && <button className="text-button danger" onClick={remove}>{ui('deleteCurrentTemplate')}</button>}</div>
    </div>
    <div className="summary-template-preview"><span>{ui('templatePreview')}</span><pre>{content}</pre></div>
  </>
}
