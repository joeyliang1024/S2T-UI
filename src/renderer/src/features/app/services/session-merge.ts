import type { SavedSession } from '../../../shared/types'

const conflictBaseId = (id: string): string => id.replace(/(?:-remote-[a-f0-9]+)+$/i, '')

/**
 * Keep one canonical record for a recording. `primary` is the authoritative
 * source (remote storage on web, local storage in Electron); fallback entries
 * fill only records it does not contain. Old conflict-copy IDs collapse back
 * onto their original recording instead of creating a second history item.
 */
export const mergeSessions = (primary: SavedSession[], fallback: SavedSession[]): SavedSession[] => {
  const entries = new Map<string, SavedSession>()
  for (const session of [...primary, ...fallback]) {
    const id = conflictBaseId(session.id)
    if (entries.has(id)) continue
    // Do not retain historical UI-only conflict labels after migrating.
    entries.set(id, { ...session, id, title: session.title.replace(/（遠端衝突版本）+$/u, '') })
  }
  return [...entries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}
