import { prompt } from '../../../shared/services/prompts'
import type { TranslationRequest } from '../ports'
import { languageName } from '../../../shared/services/settings'
export const translationMessages = (input: TranslationRequest): Array<{ role: 'system' | 'user'; content: string }> => {
  const glossary = input.glossary.trim() ? prompt('translationTerms', { glossary: input.glossary.trim() }) : ''
  return [{ role: 'system', content: input.format === 'markdown'
    ? prompt('translationMarkdown', { target: languageName(input.targetLanguage), glossary: input.glossary })
    : prompt('translation', { source: languageName(input.sourceLanguage), target: languageName(input.targetLanguage), terms: glossary }) }, { role: 'user', content: input.text }]
}
