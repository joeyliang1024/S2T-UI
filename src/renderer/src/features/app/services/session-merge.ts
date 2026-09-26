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

/**
 * The browser cannot infer edit ancestry from timestamps. Preserve divergent
 * local and remote records under distinct IDs rather than silently choosing
 * one version. The user can review both copies in History.
 */
export const mergeSessions = (local: SavedSession[], remote: SavedSession[]): SavedSession[] => {
  const entries = new Map(local.map((session) => [session.id, session]))
  for (const remoteSession of remote) {
    const localSession = entries.get(remoteSession.id)
    if (!localSession || stableJson(portable(localSession)) === stableJson(portable(remoteSession))) {
      entries.set(remoteSession.id, localSession ?? remoteSession)
      continue
    }
    const conflictId = `${remoteSession.id}-remote-${suffixFor(remoteSession)}`
    if (!entries.has(conflictId)) entries.set(conflictId, { ...remoteSession, id: conflictId, title: `${remoteSession.title}（遠端衝突版本）` })
  }
  return [...entries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}
