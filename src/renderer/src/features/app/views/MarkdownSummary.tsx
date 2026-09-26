import { type ReactElement, type ReactNode } from 'react'

const safeHref = (value: string): string | undefined => {
  try {
    const url = new URL(value, window.location.origin)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : undefined
  } catch { return undefined }
}

/** Parse a constrained Markdown subset into React nodes; generated text never becomes HTML. */
const inline = (value: string): ReactNode[] => {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  const result: ReactNode[] = []
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > cursor) result.push(value.slice(cursor, start))
    const token = match[0]; const key = `${start}-${token.length}`
    if (token.startsWith('**')) result.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) result.push(<code key={key}>{token.slice(1, -1)}</code>)
    else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token); const href = parts && safeHref(parts[2])
      result.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{parts![1]}</a> : token)
    }
    cursor = start + token.length
  }
  if (cursor < value.length) result.push(value.slice(cursor))
  return result
}

const tableCells = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
const isTableDivider = (line: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
const listItem = (line: string): { ordered: boolean; level: number; text: string } | undefined => {
  const match = /^(\s*)(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(line)
  return match ? { ordered: Boolean(match[3]), level: Math.floor(match[1].replace(/\t/g, '  ').length / 2), text: match[4] } : undefined
}

export function MarkdownSummary({ text }: { text: string }): ReactElement {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'); const blocks: ReactNode[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]; const value = line.trim()
    if (!value) { index += 1; continue }
    if (value.startsWith('```')) {
      const language = value.slice(3).trim(); const code: string[] = []; index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) code.push(lines[index++])
      if (index < lines.length) index += 1
      blocks.push(<pre className="markdown-code" key={`code-${index}`}><code data-language={language || undefined}>{code.join('\n')}</code></pre>); continue
    }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = tableCells(line); index += 2; const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]))
      blocks.push(<div className="markdown-table-wrap" key={`table-${index}`}><table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] ?? '')}</td>)}</tr>)}</tbody></table></div>); continue
    }
    if (value.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && lines[index].trim().startsWith('>')) quote.push(lines[index++].trim().replace(/^>\s?/, ''))
      blocks.push(<blockquote key={`quote-${index}`}>{quote.map((part, quoteIndex) => <p key={quoteIndex}>{inline(part)}</p>)}</blockquote>); continue
    }
    const firstItem = listItem(line)
    if (firstItem) {
      const items: Array<{ ordered: boolean; level: number; text: string }> = []
      while (index < lines.length) { const item = listItem(lines[index]); if (!item) break; items.push(item); index += 1 }
      const Tag = firstItem.ordered ? 'ol' : 'ul'
      blocks.push(<Tag className="markdown-list" key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex} className={`markdown-list-level-${Math.min(item.level, 4)}`}>{inline(item.text)}</li>)}</Tag>); continue
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(value)
    if (heading) {
      const content = inline(heading[2]); const key = `heading-${index}`; index += 1
      blocks.push(heading[1].length === 1 ? <h2 key={key}>{content}</h2> : heading[1].length === 2 ? <h3 key={key}>{content}</h3> : <h4 key={key}>{content}</h4>); continue
    }
    blocks.push(<p key={`paragraph-${index}`}>{inline(value)}</p>); index += 1
  }
  return <div className="markdown-summary">{blocks}</div>
}
