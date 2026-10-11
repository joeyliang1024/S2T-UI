import type { SavedSession } from '../../../shared/types'
export type RecoveryStage = NonNullable<SavedSession['processingStage']>
export const sessionRecoveryStages = (entry: SavedSession): RecoveryStage[] => {
  const stages = new Set<RecoveryStage>(entry.processingFailures || [])
  if (entry.processingState === 'failed' && entry.processingStage) stages.add(entry.processingStage)
  if (entry.segments.some(segment => segment.status === 'gap')) stages.add('asr')
  if (entry.segments.some(segment => segment.translationStatus === 'failed')) stages.add('translation')
  if (entry.audioUnavailable && entry.processingState === 'failed') stages.add('saving')
  return (['saving', 'asr', 'translation', 'diarization'] as const).filter(stage => stages.has(stage))
}
export const recoverSession = async (entry: SavedSession, handlers: Record<RecoveryStage, (entry: SavedSession, publish: (entry: SavedSession) => void) => Promise<SavedSession>>, progress: (entry: SavedSession) => void): Promise<SavedSession> => {
  let current = entry
  const remaining = sessionRecoveryStages(entry)
  if (!remaining.length) throw new Error('session-recovery-unknown-stage')
  for (const stage of [...remaining]) {
    current = { ...current, processingState: 'running', processingStage: stage }
    progress(current)
    try {
      current = await handlers[stage](current, updated => { current = updated; progress(current) })
      remaining.splice(remaining.indexOf(stage), 1)
      current = { ...current, processingFailures: [...remaining] }
      progress(current)
    } catch (error) {
      current = { ...current, processingState: 'failed', processingStage: undefined, processingFailures: [...remaining], processingError: error instanceof Error ? error.message : String(error) }
      progress(current)
      return current
    }
  }
  current = { ...current, processingFailures: [], processingState: 'completed', processingStage: undefined, processingError: undefined }
  progress(current)
  return current
}
