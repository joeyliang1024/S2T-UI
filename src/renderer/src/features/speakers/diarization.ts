import type { TranscriptEvent } from '../models/model-adapter'

export type SpeakerTurn = { startMs: number; endMs: number; speaker: string }

/**
 * Assign each ASR segment the diarization speaker with the greatest temporal
 * overlap. This mirrors the reconciliation step used by diarization pipelines:
 * the ASR segment's timestamp remains authoritative for subtitle rendering.
 */
export const assignSpeakersByOverlap = (entries: TranscriptEvent[], turns: SpeakerTurn[]): TranscriptEvent[] => entries.map((entry) => {
  if (entry.status !== 'final' || entry.speakerManuallyEdited) return entry
  let assigned: SpeakerTurn | undefined
  let greatestOverlap = 0
  for (const turn of turns) {
    const overlap = Math.max(0, Math.min(entry.endMs, turn.endMs) - Math.max(entry.startMs, turn.startMs))
    if (overlap > greatestOverlap) { greatestOverlap = overlap; assigned = turn }
  }
  return assigned ? { ...entry, speaker: assigned.speaker, revision: entry.revision + 1 } : entry
})

export const parseSpeakerTurns = (payload: unknown): SpeakerTurn[] => {
  if (!payload || typeof payload !== 'object') return []
  const source = payload as { segments?: unknown[]; diarization?: unknown[]; exclusive_diarization?: unknown[] }
  const raw = source.exclusive_diarization ?? source.segments ?? source.diarization ?? []
  return raw.flatMap((item): SpeakerTurn[] => {
    if (!item || typeof item !== 'object') return []
    const turn = item as { start?: unknown; end?: unknown; start_ms?: unknown; end_ms?: unknown; speaker?: unknown }
    const start = typeof turn.start_ms === 'number' ? turn.start_ms : typeof turn.start === 'number' ? Math.round(turn.start * 1000) : NaN
    const end = typeof turn.end_ms === 'number' ? turn.end_ms : typeof turn.end === 'number' ? Math.round(turn.end * 1000) : NaN
    return Number.isFinite(start) && Number.isFinite(end) && end > start && typeof turn.speaker === 'string' && turn.speaker.trim()
      ? [{ startMs: start, endMs: end, speaker: turn.speaker.trim().slice(0, 80) }] : []
  })
}
