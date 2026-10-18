import { useState, type ReactElement } from 'react'
import type { SavedSession } from '../../../../../shared/contracts/sessions'
export interface SessionConflict { id: string; local?: SavedSession; remote?: SavedSession }
export function SessionSyncConflicts({ conflicts, resolve, ui }: {
  conflicts: SessionConflict[]; resolve: (id: string, choice: 'local' | 'remote') => Promise<void>; ui: (key: string) => string
}): ReactElement | null {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  if (!conflicts.length) return null
  const choose = async (id: string, choice: 'local' | 'remote'): Promise<void> => {
    setBusy(true); setError('')
    try { await resolve(id, choice) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const preview = (entry: SavedSession | undefined): ReactElement => entry
    ? <details><summary>{entry.title || ui('untitledRecord')}</summary><pre>{(entry.transcript || entry.segments?.map(segment => segment.sourceText).join('\n') || '').slice(0, 800)}</pre></details>
    : <p>{ui('svcConflictDeleted')}</p>
  return <section className="session-sync-conflicts" role="region" aria-label={ui('svcConflictTitle')}>
    <h3>{ui('svcConflictTitle')}</h3><p>{ui('svcConflictHint')}</p>
    {conflicts.map(conflict => <fieldset key={conflict.id} disabled={busy}>
      <legend>{conflict.local?.title || conflict.remote?.title || ui('untitledRecord')}</legend>
      <div><strong>{ui('local')}</strong>{preview(conflict.local)}</div>
      <div><strong>{ui('remoteStorage')}</strong>{preview(conflict.remote)}</div>
      <button type="button" onClick={() => void choose(conflict.id, 'local')}>{ui('svcConflictKeepLocal')}</button>
      <button type="button" onClick={() => void choose(conflict.id, 'remote')}>{ui('svcConflictKeepRemote')}</button>
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
  </section>
}
