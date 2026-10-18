import { createTextSearch } from '../../../shared/services/search'
import { groupLiveCaptions } from '../../transcript/domain/live-caption'
import { captionSearchValues } from '../../transcript/domain/search'
import type { SavedSession } from '../../../../../shared/contracts/sessions'

export type HistoryQuery = {
  search: string
  sort: 'title' | 'createdAt' | 'durationMs'
  direction: 'asc' | 'desc'
  page: number
  pageSize: number
  locale: string
}

/** Derive the history screen without mutating the saved snapshot or owning UI state. */
export const sessionHistory = (sessions: SavedSession[], query: HistoryQuery) => {
  const search = createTextSearch(query.search)
  const filteredSessions = sessions.filter(entry => !search.active || search.matches(entry.title, entry.source, entry.transcript,
    ...groupLiveCaptions(entry.segments ?? []).flatMap(captionSearchValues)))
  const sortedSessions = [...filteredSessions].sort((left, right) => {
    const comparison = query.sort === 'title'
      ? left.title.localeCompare(right.title, query.locale)
      : query.sort === 'durationMs' ? left.durationMs - right.durationMs : left.createdAt.localeCompare(right.createdAt)
    return query.direction === 'asc' ? comparison : -comparison
  })
  const pageSize = Number.isInteger(query.pageSize) && query.pageSize > 0 ? query.pageSize : 10
  const historyPageCount = Math.max(1, Math.ceil(sortedSessions.length / pageSize))
  const currentHistoryPage = Math.max(1, Math.min(Number.isInteger(query.page) ? query.page : 1, historyPageCount))
  const pagedSessions = sortedSessions.slice((currentHistoryPage - 1) * pageSize, currentHistoryPage * pageSize)
  return { filteredSessions, historyPageCount, currentHistoryPage, pagedSessions }
}
