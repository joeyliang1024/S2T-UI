import type { SavedSession } from '../../../shared/types'
export type SessionStorageState = 'local' | 'remote' | 'both' | 'pending'
/** Compare each record with the last acknowledged remote snapshot. A write to
 * one record must not demote every other record to pending. */
export const sessionStorageStatesForSnapshot = (snapshot: SavedSession[], committed: SavedSession[], current: Record<string, SessionStorageState>): Record<string, SessionStorageState> => {
  const acknowledged = new Map(committed.map(entry => [entry.id, JSON.stringify(entry)]))
  return Object.fromEntries(snapshot.map(entry => [entry.id,
    entry.processingState === 'running' || acknowledged.get(entry.id) !== JSON.stringify(entry)
      ? 'pending' : current[entry.id] === 'remote' ? 'remote' : 'both'
  ]))
}
/** Keep the presentation stable while an operation is producing partial writes. */
export const displayedSessionStorageState = (state: SessionStorageState | undefined, busy: boolean): SessionStorageState => busy ? 'pending' : state ?? 'local'
