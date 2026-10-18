export type GlossaryPair = { term: string; translation: string }

export type GlossaryImport = {
  entries: string[]
  invalidEntries: number
  ignoredDuplicates: number
}

const MAX_ENTRIES = 2_000

export const parseGlossaryJson = (source: string): GlossaryImport => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('invalid-json')
  }

  const pairs: GlossaryPair[] = []
  let invalidEntries = 0
  const add = (term: unknown, translation: unknown): void => {
    if (typeof term !== 'string' || typeof translation !== 'string' || !term.trim() || !translation.trim()) {
      invalidEntries += 1
      return
    }
    pairs.push({ term: term.trim(), translation: translation.trim() })
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (typeof entry === 'string') {
        const [term, ...translation] = entry.split('=>')
        add(term, translation.join('=>'))
      } else if (entry && typeof entry === 'object') {
        add((entry as { term?: unknown }).term, (entry as { translation?: unknown }).translation)
      } else {
        invalidEntries += 1
      }
    })
  } else if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([term, translation]) => add(term, translation))
  } else {
    throw new Error('invalid-root')
  }

  const unique = [...new Set(pairs.map(({ term, translation }) => `${term} => ${translation}`))]
  if (!unique.length) throw new Error('empty-glossary')
  return { entries: unique.slice(0, MAX_ENTRIES), invalidEntries, ignoredDuplicates: Math.max(0, unique.length - MAX_ENTRIES) + pairs.length - unique.length }
}
