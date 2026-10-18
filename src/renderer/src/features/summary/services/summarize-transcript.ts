import { summaryChunks, summaryBatches } from '../domain/plan'
import type { SummaryMessage } from '../ports'

type CompleteSummary = (messages: SummaryMessage[], singleAttempt?: boolean, onText?: (text: string) => void, signal?: AbortSignal) => Promise<{ text: string }>

type Dependencies = {
  completeSummary: CompleteSummary
  summaryInstruction: () => string
  compressionFailure: () => Error
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Summary generation canceled', 'AbortError')
}

/**
 * Produces a summary without scheduling another provider request after cancellation.
 * Stages run in order deliberately: an abort between chunks, batches, or compression
 * requests therefore cannot start work from the next stage. Requests *within* one
 * stage stay concurrent — `complete` re-checks the signal before every attempt, so
 * a cancellation still issues nothing new.
 */
export const summarizeTranscript = async (
  transcript: string,
  { completeSummary, summaryInstruction, compressionFailure }: Dependencies,
  onText?: (text: string) => void,
  signal?: AbortSignal
): Promise<string> => {
  const complete = async (messages: SummaryMessage[], singleAttempt = false, stream?: (text: string) => void): Promise<string> => {
    throwIfAborted(signal)
    const result = await completeSummary(messages, singleAttempt, stream && (text => {
      throwIfAborted(signal)
      stream(text)
    }), signal)
    throwIfAborted(signal)
    return result.text
  }

  const chunks = summaryChunks(transcript)
  if (chunks.length === 1) return complete([{ role: 'system', content: summaryInstruction() }, { role: 'user', content: chunks[0] }], false, onText)

  const partials = await Promise.all(chunks.map((chunk, index) => complete([
    { role: 'system', content: `請只整理第 ${index + 1}/${chunks.length} 段會議逐字稿的事實、決策與待辦，使用簡潔 Markdown。` },
    { role: 'user', content: chunk }
  ])))

  let merged = partials
  let compressionPasses = 0
  while (merged.length > 1) {
    throwIfAborted(signal)
    const batches = summaryBatches(merged)
    // A provider can ignore a concise-output request and return a partial as
    // large as its input. Compress each such partial before retrying; never
    // silently pass only the first group to the final template request.
    if (batches.length === merged.length) {
      if (compressionPasses >= 3) throw compressionFailure()
      compressionPasses += 1
      merged = await Promise.all(merged.map((partial, index) => complete([
        { role: 'system', content: `請壓縮第 ${index + 1}/${merged.length} 段摘要，保留事實、決策與待辦；輸出必須比原文短。` },
        { role: 'user', content: partial }
      ])))
      continue
    }

    const combined = await Promise.all(batches.map((batch, index) => complete([
      { role: 'system', content: `請合併第 ${index + 1}/${batches.length} 組分段摘要，保留事實、決策與待辦，去除重複。` },
      { role: 'user', content: batch.join('\n\n---\n\n') }
    ])))
    merged = combined
    compressionPasses = 0
  }

  return complete([
    { role: 'system', content: summaryInstruction() },
    { role: 'user', content: `以下是已分層合併的會議整理，請套用模板：\n\n${merged[0] || ''}` }
  ], false, onText)
}
