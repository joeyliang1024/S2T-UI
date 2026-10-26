/** Shared literal phrase search. UI language must not change matching rules. */
export const normalizeSearchText = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()
export type TextSearch = { active: boolean; matches: (...values: Array<string | null | undefined>) => boolean }

/** Compile the query once per change; match each field independently. */
export const createTextSearch = (query: string): TextSearch => {
  const needle = normalizeSearchText(query)
  return { active: Boolean(needle), matches: (...values) => !needle || values.some(value => value != null && normalizeSearchText(value).includes(needle)) }
}
