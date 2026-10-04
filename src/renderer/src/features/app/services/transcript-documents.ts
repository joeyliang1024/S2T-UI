import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import { utils, write } from 'xlsx'
import { browserDownload } from '../../../shared/services/download'
import { makeTranscriptCsv, makeVtt, timestamp } from '../../../shared/services/transcript'
import { activeTranslate } from '../../../shared/i18n'
import type { TranscriptEvent } from '../../models/model-adapter'

export type TranscriptDownloadFormat = 'docx' | 'xlsx' | 'csv' | 'txt' | 'vtt'

/** Menu order: the formats offered by every transcript download entry point. */
export const transcriptDownloadFormats: readonly TranscriptDownloadFormat[] = ['docx', 'xlsx', 'csv', 'txt', 'vtt']

const mimeTypes: Record<TranscriptDownloadFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  vtt: 'text/vtt;charset=utf-8'
}

/** Gap markers document missing audio rather than speech, so documents skip them. */
const spokenSegments = (segments: TranscriptEvent[]): TranscriptEvent[] => segments.filter((segment) => segment.status !== 'gap')
const speakerLabel = (segment: TranscriptEvent): string => segment.speaker?.trim() || activeTranslate('unassignedSpeaker')

const plainText = (segments: TranscriptEvent[]): string => spokenSegments(segments)
  .map((segment) => `[${timestamp(segment.startMs)}] ${speakerLabel(segment)}：${segment.sourceText}${segment.translatedText ? `\n${segment.translatedText}` : ''}`)
  .join('\n\n')

const docxBlob = async (segments: TranscriptEvent[], title: string): Promise<Blob> => {
  const body = spokenSegments(segments).flatMap((segment) => [
    new Paragraph({
      children: [
        new TextRun({ text: `[${timestamp(segment.startMs)}] `, bold: true }),
        new TextRun({ text: `${speakerLabel(segment)}：`, bold: true }),
        new TextRun({ text: segment.sourceText })
      ]
    }),
    ...(segment.translatedText ? [new Paragraph({ children: [new TextRun({ text: segment.translatedText, italics: true, color: '475569' })] })] : [])
  ])
  const document = new Document({ sections: [{ children: [new Paragraph({ text: title, heading: HeadingLevel.TITLE }), ...body] }] })
  return Packer.toBlob(document)
}

const sheetName = (title: string): string => {
  const cleaned = title.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31)
  return cleaned || activeTranslate('transcriptFile')
}

const xlsxBlob = (segments: TranscriptEvent[], title: string): Blob => {
  const rows: Array<Array<string | number>> = [
    [activeTranslate('time'), activeTranslate('startMilliseconds'), activeTranslate('endMilliseconds'), activeTranslate('speaker'), activeTranslate('sourceText'), activeTranslate('translation')],
    ...spokenSegments(segments).map((segment) => [timestamp(segment.startMs), segment.startMs, segment.endMs, speakerLabel(segment), segment.sourceText, segment.translatedText ?? ''])
  ]
  const sheet = utils.aoa_to_sheet(rows)
  sheet['!cols'] = [{ wch: 9 }, { wch: 11 }, { wch: 11 }, { wch: 14 }, { wch: 60 }, { wch: 60 }]
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, sheet, sheetName(title))
  const bytes = write(workbook, { type: 'array', bookType: 'xlsx' })
  return new Blob([bytes], { type: mimeTypes.xlsx })
}

/**
 * Builds one export file. Returns null when the record has no exportable
 * content, so callers can explain instead of saving an empty document.
 */
export const transcriptBlob = async (
  segments: TranscriptEvent[],
  title: string,
  format: TranscriptDownloadFormat,
  fallbackText = ''
): Promise<Blob | null> => {
  if (format === 'txt') {
    const text = spokenSegments(segments).length ? plainText(segments) : fallbackText
    return text ? new Blob([text], { type: mimeTypes.txt }) : null
  }
  if (!segments.length) return null
  if (format === 'docx') return docxBlob(segments, title)
  if (format === 'xlsx') return xlsxBlob(segments, title)
  if (format === 'csv') return new Blob([makeTranscriptCsv(segments)], { type: mimeTypes.csv })
  return new Blob([makeVtt(segments)], { type: mimeTypes.vtt })
}

export const transcriptFilename = (title: string, format: TranscriptDownloadFormat): string => `${title}.${format}`

export const downloadTranscriptBlob = (blob: Blob, title: string, format: TranscriptDownloadFormat): void => {
  browserDownload(blob, transcriptFilename(title, format))
}
