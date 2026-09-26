import type { SummaryTemplate } from '../../../shared/types'

export const defaultCustomTemplate = '# 會議摘要\n'

export const selectSummaryTemplate = (templates: SummaryTemplate[], id: string): { selectedSummaryTemplateId: string; summaryTemplate: string } | null => {
  const template = templates.find((item) => item.id === id)
  return template ? { selectedSummaryTemplateId: template.id, summaryTemplate: template.content } : null
}

export const addSummaryTemplate = (templates: SummaryTemplate[], id: string, name: string, content: string): { templates: SummaryTemplate[]; selectedSummaryTemplateId: string; summaryTemplate: string } => {
  const template: SummaryTemplate = { id, name: name.trim().slice(0, 100), content: content.trim().slice(0, 20_000) || defaultCustomTemplate }
  if (!template.name) throw new Error('template-name-required')
  return { templates: [...templates, template], selectedSummaryTemplateId: template.id, summaryTemplate: template.content }
}

export const removeSelectedSummaryTemplate = (templates: SummaryTemplate[], selectedId: string): { templates: SummaryTemplate[]; selectedSummaryTemplateId: string; summaryTemplate: string } => {
  if (templates.length <= 1) throw new Error('last-template')
  const remaining = templates.filter((template) => template.id !== selectedId)
  const selected = remaining[0]
  if (!selected) throw new Error('last-template')
  return { templates: remaining, selectedSummaryTemplateId: selected.id, summaryTemplate: selected.content }
}
