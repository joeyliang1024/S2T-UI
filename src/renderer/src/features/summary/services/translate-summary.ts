import type { SavedSession } from '../../../../../shared/contracts/sessions'
import type { TextCompletionPort } from '../../translation/ports'

type Dependencies = { generations: Map<string, string>; complete: TextCompletionPort['complete']; publish: (entry: SavedSession, text: string, translated: string, targetLanguage: string) => void; emptyError: () => Error }
export const translateSessionSummary = async (entry: SavedSession, input: { sourceLanguage: string; targetLanguage: string; glossary: string }, { generations, complete, publish, emptyError }: Dependencies): Promise<void> => {
  const text = entry.summary?.trim()
  if (!text || text === '正在產生摘要…') return
  const generation = crypto.randomUUID()
  generations.set(entry.id, generation)
  try {
    const { text: translated } = await complete({ text, ...input, format: 'markdown', timeoutMs: 90_000 })
    if (generations.get(entry.id) !== generation) return
    if (!translated?.trim()) throw emptyError()
    publish(entry, text, translated, input.targetLanguage)
  } finally { if (generations.get(entry.id) === generation) generations.delete(entry.id) }
}
