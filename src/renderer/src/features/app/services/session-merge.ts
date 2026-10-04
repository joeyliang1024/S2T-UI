import type { SavedSession } from '../../../shared/types'
import { activeTranslate } from '../../../shared/i18n'

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
    const previous = entries.get(id)
    if (previous) {
      // A server-owned final speaker pass must not be overwritten by a stale
      // running snapshot on a CAS rebase. A new capture token remains authoritative.
      if (previous.processingState === 'running' && previous.processingStage === 'diarization'
        && previous.processingToken && previous.processingToken === session.processingToken
        && (session.processingState === 'completed' || session.processingState === 'failed' && !session.processingStage)) entries.set(id, { ...session, id })
      continue
    }
    // Do not retain historical UI-only conflict labels after migrating.
    entries.set(id, { ...session, id, title: session.title.replace(/（遠端衝突版本）+$/u, '') })
  }
  return [...entries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/**
 * A record left in `running` with nobody able to finish it is worse than a
 * visible failure: continue, summarize, quality-correct and load are all gated
 * on that state, so the record turns unactionable for the rest of the session
 * — and nothing resumes it after a restart either. Only `delete` stayed open,
 * which is a poor consolation prize for a record the user did not break.
 *
 * Call this once per load/merge, never on a save path:
 * - `finishing` names the record this page is actively processing right now, so
 *   a provisional `running` written by stopCapture is never demoted.
 * - on web, `durableJobs` keeps any record that still carries a job id waiting
 *   for the poller's answer instead of guessing at it.
 */
export const recoverStaleProcessing = (
  sessions: SavedSession[],
  options: { finishing?: { id: string; token: string } | null; durableJobs?: boolean } = {}
): SavedSession[] => {
  const { finishing = null, durableJobs = false } = options
  let recovered = false
  const next = sessions.map((session) => {
    if (session.processingState !== 'running') return session
    if (finishing && finishing.id === session.id && finishing.token === session.processingToken) return session
    if (durableJobs && session.diarizationJobId) return session
    recovered = true
    return { ...session, processingState: 'failed' as const, processingStage: undefined, processingError: activeTranslate('svcInterruptedProcessing') }
  })
  // Same reference when nothing changed: setSessions must not schedule a save
  // (or a re-render) just because the app was opened.
  return recovered ? next : sessions
}
