import type { LiveTranscriptDraft, SavedSession } from '../../../../shared/contracts/sessions'
import type { RecordingRecoveryEntry } from '../../capture/recording/recovery-manifest'
import { makeTranscriptText } from '../../../shared/services/transcript'

type Source = { draft: LiveTranscriptDraft; manifest?: RecordingRecoveryEntry }
type Dependencies = {
  readAudio: (source: Source) => Promise<Blob | null | undefined>
  saveAudio: (key: string, audio: Blob) => Promise<unknown>
  hasAudio: (key: string) => Promise<boolean>
  acknowledge: (source: Source, target: { sessionId: string; audioKey: string; processingToken?: string }) => Promise<void>
  registerCleanup: (id: string, audioKey: string, cleanup: () => Promise<void>, token?: string) => void
  title: (draft: LiveTranscriptDraft) => string
  sourceLabel: (draft: LiveTranscriptDraft) => string
  isActive: () => boolean
  onError: (error: unknown) => void
}
export const recoverRecordings = async ({ manifests, legacyDraft, remoteSessions }: { manifests: RecordingRecoveryEntry[]; legacyDraft?: LiveTranscriptDraft; remoteSessions: SavedSession[] }, deps: Dependencies): Promise<SavedSession[]> => {
  const sources: Source[] = manifests.map(manifest => ({ manifest, draft: manifest.draft }))
  if (legacyDraft && !sources.some(source => source.draft.id === legacyDraft.id)) sources.push({ draft: legacyDraft })
  const recovered: SavedSession[] = []
  const check = (): void => { if (!deps.isActive()) throw new DOMException('Account changed', 'AbortError') }
  for (const source of sources) {
    if (!deps.isActive()) break
    const { draft, manifest } = source, id = `recovery-live-${draft.id}`
    const target = manifest?.target
    const committed = remoteSessions.find(entry => entry.audioUnavailable === false && (
      (target && entry.id === target.sessionId && entry.audioKey === target.audioKey && entry.processingToken === target.processingToken && !['asr', 'translation', 'saving'].includes(entry.processingStage ?? '')) ||
      (entry.id === id && entry.audioKey === id) || (!manifest && entry.id === draft.id)))
    const cleanup = (row: SavedSession) => async (): Promise<void> => { check(); await deps.acknowledge(source, { sessionId: row.id, audioKey: row.audioKey || row.id, processingToken: row.processingToken }) }
    if (committed) { deps.registerCleanup(committed.id, committed.audioKey || committed.id, cleanup(committed), committed.processingToken); continue }
    const audioKey = draft.opfsRecordingId ? id : ''
    let available = false, audio: Blob | null | undefined
    try {
      if (draft.opfsRecordingId && draft.sampleRate) {
        audio = await deps.readAudio(source); check()
        if (audio) { await deps.saveAudio(audioKey, audio); check(); available = await deps.hasAudio(audioKey); check() }
      }
    } catch (error) { if (!deps.isActive()) break; deps.onError(error) }
    const offset = manifest?.captureOffsetMs ?? 0
    // A continuation's OPFS source is only its new tail; preserve the existing session and align recovered captions to that tail.
    const segments = draft.segments.filter(segment => !offset || segment.endMs > offset).map(segment => offset ? { ...segment, startMs: Math.max(0, segment.startMs - offset), endMs: Math.max(0, segment.endMs - offset) } : segment)
    if (!segments.length && !audio) continue
    const durationMs = audio && draft.sampleRate ? Math.max(0, (audio.size - 44) / (draft.sampleRate * 2) * 1000) : Math.max(0, draft.elapsedMs - offset)
    recovered.push({ id, title: deps.title(draft), createdAt: draft.startedAt, durationMs, source: deps.sourceLabel(draft), transcript: makeTranscriptText(segments), audioKey, savedToDisk: false, audioUnavailable: !available, segments })
    if (available) deps.registerCleanup(id, audioKey, cleanup(recovered[recovered.length - 1]))
  }
  return recovered
}
