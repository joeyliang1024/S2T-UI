import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import { browserDownload } from '../../../shared/services/download'

export type SummaryDownloadFormat = 'txt' | 'markdown' | 'docx'

/** Menu order: the formats offered by every summary download entry point. */
export const summaryDownloadFormats: readonly SummaryDownloadFormat[] = ['txt', 'markdown', 'docx']

const mimeTypes: Record<SummaryDownloadFormat, string> = {
  txt: 'text/plain;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

/** Strip Markdown syntax so the plain-text export stays readable. */
const plainText = (markdown: string): string => markdown
  .replace(/```[^\n]*\n?/g, '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^>\s?/gm, '')
  .replace(/^\s*[-*+]\s+/gm, '· ')
  .replace(/^\s*\d+\.\s+/gm, '')
  .replace(/^-{3,}\s*$/gm, '')
  .replace(/\|/g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const docxBlob = async (markdown: string, title: string): Promise<Blob> => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const line of lines) {
    const value = line.trim()
    if (!value) continue
    const heading = /^(#{1,4})\s+(.+)$/.exec(value)
    if (heading) {
      const level = heading[1].length
      children.push(new Paragraph({ text: heading[2], heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3 }))
      continue
    }
    const item = /^(\s*)(?:[-*+]|\d+\.)\s+(.+)$/.exec(line)
    if (item) {
      const level = Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), 4)
      children.push(new Paragraph({ text: item[2], bullet: { level } }))
      continue
    }
    if (value.startsWith('>')) { children.push(new Paragraph({ children: [new TextRun({ text: value.replace(/^>\s?/, ''), italics: true })] })); continue }
    children.push(new Paragraph({ text: value }))
  }
  const document = new Document({ sections: [{ children }] })
  return Packer.toBlob(document)
}

/**
 * Builds one summary export file. Returns null when there is no exportable
 * content, so callers can explain instead of saving an empty document.
 */
export const summaryBlob = async (text: string, title: string, format: SummaryDownloadFormat): Promise<Blob | null> => {
  const content = text.trim()
  if (!content) return null
  if (format === 'txt') return new Blob([plainText(content)], { type: mimeTypes.txt })
  if (format === 'markdown') return new Blob([content], { type: mimeTypes.markdown })
  return docxBlob(content, title)
}

export const summaryFilename = (title: string, format: SummaryDownloadFormat): string => `${title}.${format === 'markdown' ? 'md' : format}`

export const downloadSummaryBlob = (blob: Blob, title: string, format: SummaryDownloadFormat): void => {
  browserDownload(blob, summaryFilename(title, format))
}
