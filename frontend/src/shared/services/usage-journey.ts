import { authFetch } from '../http/authenticated-client'

// Best effort; no automatic retries that could count one user action twice.
export const recordJourney = (stage: 'L1' | 'L2' | 'L3'): void => {

  void authFetch('/api/telemetry/journey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage }), signal: AbortSignal.timeout(3000) }).catch(() => undefined)
}
let entered = false
export const recordJourneyEntry = (): void => {
  if (entered) return
  entered = true
  recordJourney('L1')
}
