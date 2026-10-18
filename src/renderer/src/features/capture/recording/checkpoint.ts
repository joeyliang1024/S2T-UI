import type { LiveTranscriptDraft } from '../../../../../shared/contracts/sessions'

type Checkpoints = { read: () => LiveTranscriptDraft | undefined; local: (draft: LiveTranscriptDraft) => Promise<void> | undefined; remote: (draft: LiveTranscriptDraft) => Promise<void>; onError: (error: unknown) => void; clock: Pick<Window, 'setInterval' | 'clearInterval'>; isActive?: () => boolean }
/** Fixed cadence, independent writers: remote outages cannot starve local recovery metadata. */
export const startRecordingCheckpoints = ({ read, local, remote, onError, clock, isActive = () => true }: Checkpoints): (() => void) => {
  let stopped = false
  const busy = { local: false, remote: false }
  const save = (kind: keyof typeof busy, write: Checkpoints['local'], draft: LiveTranscriptDraft): void => {
    if (busy[kind]) return
    busy[kind] = true
    void Promise.resolve().then(() => { if (!stopped && isActive()) return write(draft) }).catch(error => { if (!stopped && isActive()) onError(error) }).finally(() => { busy[kind] = false })
  }
  const tick = (): void => {
    if (stopped || !isActive()) return
    const value = read()
    if (!value) return
    const draft = structuredClone(value)
    save('local', local, draft); save('remote', remote, draft)
  }
  tick()
  const timer = clock.setInterval(tick, 1000)
  return () => { stopped = true; clock.clearInterval(timer) }
}
