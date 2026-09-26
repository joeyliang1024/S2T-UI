import { type TranscriptEvent } from '../../features/models/model-adapter'

export const joinCaptionText = (previous: string, next: string): string => {
  const needsSpace = /[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(next)
  return `${previous}${needsSpace ? ' ' : ''}${next}`
}

export const timestamp = (milliseconds: number): string => {
  const total = Math.floor(milliseconds / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const vttTime = (milliseconds: number): string => {
  const total = Math.max(0, milliseconds); const hours = Math.floor(total / 3_600_000); const minutes = Math.floor(total % 3_600_000 / 60_000); const seconds = Math.floor(total % 60_000 / 1_000); const ms = Math.floor(total % 1_000)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

const vttText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const vttVoice = (value: string): string => value.replace(/[\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim()

export const makeVtt = (entries: TranscriptEvent[]): string => `WEBVTT\n\n${entries
  .filter((entry) => entry.status === 'final' && Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs) && entry.startMs >= 0 && entry.endMs > entry.startMs)
  .map((entry) => {
    const voice = vttVoice(entry.speaker || '未標記講者')
    const speaker = `<v ${voice}>`
    return `${vttTime(entry.startMs)} --> ${vttTime(entry.endMs)}\n${speaker}${vttText(entry.sourceText)}${entry.translatedText ? `\n${speaker}${vttText(entry.translatedText)}` : ''}`
  })
  .join('\n\n')}\n`

export type TranscriptTextOptions = { includeTimestamp?: boolean; includeSpeaker?: boolean; includeTranslation?: boolean }

export const makeTranscriptText = (entries: TranscriptEvent[], options: boolean | TranscriptTextOptions = true): string => {
  const normalized = typeof options === 'boolean' ? { includeTimestamp: true, includeSpeaker: options, includeTranslation: true } : { includeTimestamp: true, includeSpeaker: true, includeTranslation: true, ...options }
  return entries
  .filter((entry) => entry.status === 'final')
  .map((entry) => `${normalized.includeTimestamp ? `[${timestamp(entry.startMs)}] ` : ''}${normalized.includeSpeaker ? `${entry.speaker?.trim() || '未標記講者'}：` : ''}${entry.sourceText}${normalized.includeTranslation && entry.translatedText ? `\n${entry.translatedText}` : ''}`)
  .join('\n\n')
}

export const makeTranscriptCsv = (entries: TranscriptEvent[]): string => {
  const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`
  const header = ['start_ms', 'end_ms', 'start_time', 'end_time', 'speaker', 'source_text', 'translated_text', 'status', 'gap_reason']
  const rows = entries.map((entry) => [entry.startMs, entry.endMs, timestamp(entry.startMs), timestamp(entry.endMs), entry.speaker, entry.sourceText, entry.translatedText, entry.status, entry.gapReason].map(escape).join(','))
  return `\uFEFF${header.join(',')}\n${rows.join('\n')}`
}
