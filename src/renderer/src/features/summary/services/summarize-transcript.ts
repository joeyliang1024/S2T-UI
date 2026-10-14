import { summaryChunks, summaryBatches } from '../domain/plan'
import type { SummaryMessage } from '../ports'

export const summarizeTranscript = async (transcript: string, { completeSummary, summaryInstruction, compressionFailure }: { completeSummary: (messages: SummaryMessage[], singleAttempt?: boolean, onText?: (text: string) => void) => Promise<{ text: string }>; summaryInstruction: () => string; compressionFailure: () => Error }, onText?: (text: string) => void): Promise<string> => {
  const chunks = summaryChunks(transcript)
  if (chunks.length === 1) return (await completeSummary([{ role: 'system', content: summaryInstruction() }, { role: 'user', content: chunks[0] }], false, onText)).text
  const partials: string[] = []
  for (const [index, chunk] of chunks.entries()) partials.push((await completeSummary([{ role: 'system', content: `請只整理第 ${index + 1}/${chunks.length} 段會議逐字稿的事實、決策與待辦，使用簡潔 Markdown。` }, { role: 'user', content: chunk }])).text)
  let merged = partials
  let compressionPasses = 0
  while (merged.length > 1) {
    const batches = summaryBatches(merged)
    // A provider can ignore a concise-output request and return a partial as
    // large as its input. Compress each such partial before retrying; never
    // silently pass only the first group to the final template request.
    if (batches.length === merged.length) {
      if (compressionPasses >= 3) throw compressionFailure()
      compressionPasses += 1
      merged = await Promise.all(merged.map(async (partial, index) => (await completeSummary([
        { role: 'system', content: `請壓縮第 ${index + 1}/${merged.length} 段摘要，保留事實、決策與待辦；輸出必須比原文短。` },
        { role: 'user', content: partial }
      ])).text))
      continue
    }
    merged = await Promise.all(batches.map(async (batch, index) => (await completeSummary([{ role: 'system', content: `請合併第 ${index + 1}/${batches.length} 組分段摘要，保留事實、決策與待辦，去除重複。` }, { role: 'user', content: batch.join('\n\n---\n\n') }])).text))
    compressionPasses = 0
  }
  return (await completeSummary([{ role: 'system', content: summaryInstruction() }, { role: 'user', content: `以下是已分層合併的會議整理，請套用模板：\n\n${merged[0] || ''}` }], false, onText)).text
}

