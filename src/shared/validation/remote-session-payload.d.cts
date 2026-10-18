import type { ImportCheckpoint, LiveTranscriptDraft, SavedSession } from '../contracts/sessions'

export function parseSessionsResponse(value: unknown): { sessions: SavedSession[]; version: number }
export function parseLiveDraftResponse(value: unknown): LiveTranscriptDraft | undefined
export function parseImportCheckpointResponse(value: unknown): ImportCheckpoint | undefined
