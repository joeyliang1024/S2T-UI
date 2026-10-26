import type { SavedSession } from '../../../../shared/contracts/sessions'
import { rebaseSessions, SessionMergeConflictError } from '../domain/session-merge'
import type { SessionOutbox, SessionOutboxSnapshot } from './session-outbox'

type RemoteSnapshot = { sessions: SavedSession[]; version: number }
export type SessionConflict = { baseline: SavedSession[]; local: SavedSession[]; remote: SavedSession[]; version: number; ids: string[] }
export type SessionSyncState = { baseline: SavedSession[]; local: SavedSession[]; pending: SavedSession[] | null; version: number | null; status: 'ready' | 'syncing' | 'paused'; acknowledged: boolean; conflicts: Array<{ id: string; local?: SavedSession; remote?: SavedSession }> }
type Dependencies = {
  remote: { load: () => Promise<RemoteSnapshot>; save: (rows: SavedSession[], version: number) => Promise<number> }
  openOutbox: () => SessionOutbox
  clock: Pick<Window, 'setTimeout' | 'clearTimeout'>
  isActive: () => boolean
  recover: (rows: SavedSession[]) => SavedSession[]
  onLocal: (rows: SavedSession[]) => void
  onState: (state: SessionSyncState) => void
  onError: (error: unknown) => void
}
class UnreadCheckpointError extends Error {}
/** Account-scoped state machine. React receives snapshots; no React refs, platform checks or global credentials live here. */
export const createSessionSyncCoordinator = (deps: Dependencies) => {
  let baseline: SavedSession[] = [], local: SavedSession[] = [], pending: SavedSession[] | null = null
  let version: number | null = null, syncing = false, loading = false, closed = false, acknowledged = false
  let conflict: SessionConflict | null = null, outbox: SessionOutbox | null = null, restored = false
  let retryTimer: number | undefined, retryAttempt = 0, retrying: Promise<void> | undefined
  const cleanup = new Map<string, { audioKey: string; token?: string; run: () => Promise<void> }>()
  const active = (): boolean => !closed && deps.isActive()
  const check = (): void => { if (!active()) throw new DOMException('Account changed', 'AbortError') }
  const state = (): SessionSyncState => ({ baseline, local, pending, version, status: version === null ? 'paused' : syncing ? 'syncing' : 'ready', acknowledged,
    conflicts: conflict?.ids.map(id => ({ id, local: conflict!.local.find(row => row.id === id), remote: conflict!.remote.find(row => row.id === id) })) ?? [] })
  const emit = (): void => { if (active()) deps.onState(state()) }
  const publish = (rows: SavedSession[]): void => { local = rows; if (active()) deps.onLocal(rows) }
  const remember = (error: SessionMergeConflictError, base: SavedSession[], desired: SavedSession[], remote: RemoteSnapshot): void => {
    conflict = { baseline: base, local: desired, remote: remote.sessions, version: remote.version, ids: error.sessionIds }
    if (retryTimer !== undefined) deps.clock.clearTimeout(retryTimer)
    retryTimer = undefined
  }
  const schedule = (): void => {
    if (!active() || conflict || retryTimer !== undefined) return
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryAttempt++, 5))
    retryTimer = deps.clock.setTimeout(() => { retryTimer = undefined; if (syncing || loading) schedule(); else void retry() }, delay)
  }
  const pause = (error: unknown): void => {
    if (!active()) return
    version = null; acknowledged = false; emit(); deps.onError(error)
    if (!(error instanceof SessionMergeConflictError) && !(error instanceof UnreadCheckpointError)) schedule()
  }
  const restoreCheckpoint = async (): Promise<SessionOutboxSnapshot | undefined> => {
    check()
    const candidate = outbox ?? deps.openOutbox()
    outbox = candidate
    try { const snapshot = await candidate.read(); check(); restored = true; return snapshot }
    catch (error) { if (outbox === candidate) outbox = null; await candidate.close().catch(() => undefined); throw error }
  }
  const checkpoint = async (base: SavedSession[], rows: SavedSession[]): Promise<void> => {
    check()
    if (!outbox || !restored) throw new Error('Session recovery queue is unavailable; pending changes were retained')
    await outbox.save({ baseline: base, local: rows }); check()
  }
  const runCleanup = async (committed: SavedSession[]): Promise<void> => {
    for (const [id, task] of cleanup) {
      check()
      if (!committed.some(row => row.id === id && row.audioKey === task.audioKey && row.audioUnavailable === false && row.processingState !== 'running' && (task.token === undefined || row.processingToken === task.token))) continue
      try { await task.run(); check(); if (cleanup.get(id) === task) cleanup.delete(id) }
      catch { if (active()) schedule() }
    }
  }
  const record = (rows: SavedSession[]): void => {
    if (!active() || rows === baseline && pending === null) return
    local = rows; pending = rows; acknowledged = false
    if (conflict) conflict.local = rows
    emit()
    void checkpoint(conflict?.baseline ?? baseline, rows).catch(pause)
  }
  const pump = async (): Promise<void> => {
    if (!active() || syncing || loading || version === null || conflict) return
    syncing = true; emit()
    let last: SavedSession[] | null = null
    try {
      while (pending && version !== null) {
        let next: SavedSession[] = pending, uiBase = next, checkpointBase = baseline
        const mergeBase = baseline
        last = next; pending = null
        for (;;) {
          try {
            await checkpoint(checkpointBase, next)
            const savedVersion = await deps.remote.save(next, version!)
            check(); version = savedVersion; break
          } catch (error) {
            check()
            if (!(error instanceof Error) || !/遠端記錄已有更新|HTTP 409/.test(error.message)) throw error
            const remote = await deps.remote.load(); check()
            const desired: SavedSession[] = pending ?? uiBase
            pending = null; last = desired; uiBase = desired
            try { next = rebaseSessions(mergeBase, desired, remote.sessions) }
            catch (error) { if (error instanceof SessionMergeConflictError) remember(error, mergeBase, desired, remote); throw error }
            checkpointBase = remote.sessions; version = remote.version
          }
        }
        check(); baseline = next
        if (pending) {
          try { pending = rebaseSessions(uiBase, pending, next) }
          catch (error) { if (error instanceof SessionMergeConflictError) remember(error, uiBase, pending, { sessions: next, version: version! }); throw error }
        }
        publish(pending ?? next)
        await runCleanup(next)
        if (!pending) {
          const ack = await outbox!.acknowledge(next); check()
          if (ack) {
            const recovered = await outbox!.read(); check()
            if (recovered) {
              const desired = pending ?? baseline
              try { pending = rebaseSessions(recovered.baseline, recovered.local, desired) }
              catch (error) {
                if (error instanceof SessionMergeConflictError) remember(error, recovered.baseline, recovered.local, { sessions: desired, version: version! })
                throw error
              }
              publish(pending)
            }
          }
        }
        acknowledged = !pending; emit()
      }
    } catch (error) { if (active()) { pending ??= last; pause(error) } }
    finally { syncing = false; emit() }
  }
  const enqueue = (rows: SavedSession[]): void => {
    if (!active()) return
    if (rows === baseline && pending === null && !cleanup.size) return
    if (pending !== rows) record(rows)
    void pump()
  }
  const retry = (): Promise<void> => {
    if (!active() || syncing) return Promise.resolve()
    if (retrying) return retrying
    if (retryTimer !== undefined) deps.clock.clearTimeout(retryTimer)
    retryTimer = undefined
    loading = true
    retrying = (async () => {
      try {
        const disk = !restored ? await restoreCheckpoint() : undefined
        const remote = await deps.remote.load(); check()
        let desired = pending ?? local, rebased: SavedSession[]
        if (disk && JSON.stringify(desired) !== JSON.stringify(baseline)) { restored = false; throw new UnreadCheckpointError('A previously unread recovery checkpoint was retained; reload after preserving current edits before replacing it') }
        const base = disk?.baseline ?? baseline
        desired = disk?.local ?? desired
        try { rebased = rebaseSessions(base, desired, remote.sessions) }
        catch (error) { if (error instanceof SessionMergeConflictError) remember(error, base, desired, remote); throw error }
        baseline = remote.sessions; version = remote.version
        publish(deps.recover(rebased)); pending = local; acknowledged = false
        retryAttempt = 0; emit()
      } catch (error) { pause(error) }
      finally { loading = false; retrying = undefined }
      if (version !== null && !conflict) await pump()
    })()
    return retrying
  }
  return {
    getState: state,
    restoreCheckpoint,
    initialize: (input: { baseline: SavedSession[]; local: SavedSession[]; version: number | null; conflict?: SessionConflict }) => {
      check(); baseline = input.baseline; local = input.local; pending = local === baseline ? null : local
      version = restored && outbox ? input.version : null; conflict = input.conflict ?? null; acknowledged = false
      emit(); if (version === null && !conflict) schedule()
    },
    record, enqueue, retry,
    registerCleanup: (id: string, audioKey: string, run: () => Promise<void>, token?: string): void => { if (active()) { cleanup.set(id, { audioKey, token, run }); schedule() } },
    resolve: async function resolve(id: string, choice: 'local' | 'remote'): Promise<void> {
      check(); if (!conflict?.ids.includes(id)) return
      const current = conflict, beforeLocal = conflict.local, remoteRow = current.remote.find(row => row.id === id)
      const replace = (rows: SavedSession[], value?: SavedSession): SavedSession[] => [...rows.filter(row => row.id !== id), ...(value ? [value] : [])]
      const nextBase = replace(current.baseline, remoteRow), nextLocal = choice === 'remote' ? replace(current.local, remoteRow) : current.local
      await checkpoint(nextBase, nextLocal); check()
      if (conflict !== current) return
      if (current.local !== beforeLocal) return resolve(id, choice)
      current.baseline = nextBase; current.local = nextLocal; current.ids = current.ids.filter(value => value !== id)
      baseline = nextBase; pending = nextLocal; publish(nextLocal); emit()
      if (!current.ids.length) { conflict = null; await retry() }
    },
    close: async (): Promise<void> => {
      closed = true
      if (retryTimer !== undefined) deps.clock.clearTimeout(retryTimer)
      retryTimer = undefined
      await outbox?.close()
    }
  }
}
export type SessionSyncCoordinator = ReturnType<typeof createSessionSyncCoordinator>
