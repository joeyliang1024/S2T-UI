import type { LiveTranscriptDraft } from '../../../../../shared/contracts/sessions'
export type RecordingRecoveryEntry = { version: 1; ownerId: string; recordingId: string; draft: LiveTranscriptDraft; captureOffsetMs?: number; target?: { sessionId: string; audioKey: string; processingToken: string } }
const storedKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
export const validateRecoveryEntry = (value: unknown, recordingId: string): RecordingRecoveryEntry => {
  const record = value as Partial<RecordingRecoveryEntry> | null, draft = record?.draft
  if (!record || record.version !== 1 || !id(record.ownerId) || record.recordingId !== recordingId || !draft || !id(draft.id) || draft.opfsRecordingId !== recordingId || !Number.isInteger(draft.sampleRate) || draft.sampleRate! <= 0 || !Number.isFinite(draft.elapsedMs) || draft.elapsedMs < 0 || !Number.isFinite(Date.parse(draft.startedAt)) || !Number.isFinite(Date.parse(draft.updatedAt)) || !['recording','paused'].includes(draft.captureState) || typeof draft.source !== 'string' || !Array.isArray(draft.segments)) throw new Error('Recording recovery manifest is invalid; source retained')
  for (const segment of draft.segments) if (!segment || typeof segment.id !== 'string' || typeof segment.sourceText !== 'string' || !['partial','final','gap'].includes(segment.status) || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)) throw new Error('Recording recovery transcript is invalid; source retained')
  if (record.captureOffsetMs !== undefined && (!Number.isFinite(record.captureOffsetMs) || record.captureOffsetMs < 0)) throw new Error('Recording recovery offset is invalid')
  if (record.target && (!storedKey(record.target.sessionId) || !storedKey(record.target.audioKey) || !id(record.target.processingToken))) throw new Error('Recording recovery target is invalid; source retained')
  return record as RecordingRecoveryEntry
}
