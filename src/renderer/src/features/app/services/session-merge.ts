import type { SavedSession } from '../../../shared/types'

const portable = (session: SavedSession): Omit<SavedSession, 'nativeAudioPath' | 'savedToDisk'> => {
  const { nativeAudioPath: _nativeAudioPath, savedToDisk: _savedToDisk, ...value } = session
  return value
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value)
}

const suffixFor = (session: SavedSession): string => {
  let hash = 2166136261
  for (const character of stableJson(portable(session))) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  return hash.toString(16)
}

const remoteConflictMarker = '（遠端衝突版本）'

const conflictBaseId = (id: string): string => id.replace(/(?:-remote-[a-f0-9]+)+$/i, '')

const isRemoteConflict = (session: SavedSession): boolean => /(?:-remote-[a-f0-9]+)+$/i.test(session.id)

// Repeated reload/merge cycles may receive an already-labelled conflict copy.
// Keep the marker idempotent so a retry never changes its display title again.
const remoteConflictTitle = (title: string): string => `${title.replace(/(?:（遠端衝突版本）)+$/u, '')}${remoteConflictMarker}`

const normalizeConflictSession = (session: SavedSession): SavedSession => isRemoteConflict(session) && session.title.endsWith(remoteConflictMarker)
  ? { ...session, title: remoteConflictTitle(session.title) }
  : session

/**
 * The browser cannot infer edit ancestry from timestamps. Preserve divergent
 * local and remote records under distinct IDs rather than silently choosing
 * one version. The user can review both copies in History.
 */
export const mergeSessions = (local: SavedSession[], remote: SavedSession[]): SavedSession[] => {
  const entries = new Map(local.map((session) => {
    const normalized = normalizeConflictSession(session)
    return [normalized.id, normalized]
  }))
  for (const remoteSession of remote) {
    const localSession = entries.get(remoteSession.id)
    if (!localSession || stableJson(portable(localSession)) === stableJson(portable(remoteSession))) {
      entries.set(remoteSession.id, localSession ?? remoteSession)
      continue
    }
    const conflictId = `${conflictBaseId(remoteSession.id)}-remote-${suffixFor(remoteSession)}`
    if (!entries.has(conflictId)) entries.set(conflictId, { ...remoteSession, id: conflictId, title: remoteConflictTitle(remoteSession.title) })
  }
  return [...entries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}
