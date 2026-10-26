import { orderedWindow } from '../../../shared/services/ordered-window'
import { prompt } from '../../../shared/services/prompts'
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

  const mapBackground = async <T>(items: T[], produce: (item: T, index: number) => Promise<string>): Promise<string[]> => {
    const results: string[] = []
    await orderedWindow({ start: 0, end: items.length, concurrency: 2,
      cancelled: () => Boolean(signal?.aborted),
      produce: index => produce(items[index], index),
      commit: async (value, index) => { results[index] = value } })
    return results
  }
  const chunks = summaryChunks(transcript)
  if (chunks.length === 1) return complete([{ role: 'system', content: summaryInstruction() }, { role: 'user', content: chunks[0] }], false, onText)

  const partials = await mapBackground(chunks, (chunk, index) => complete([
    { role: 'system', content: prompt('summaryChunk', { index: index + 1, count: chunks.length }) },
    { role: 'user', content: chunk }
  ]))

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
      merged = await mapBackground(merged, (partial, index) => complete([
        { role: 'system', content: prompt('summaryCompress', { index: index + 1, count: merged.length }) },
        { role: 'user', content: partial }
      ]))
      continue
    }

    const combined = await mapBackground(batches, (batch, index) => complete([
      { role: 'system', content: prompt('summaryMerge', { index: index + 1, count: batches.length }) },
      { role: 'user', content: batch.join('\n\n---\n\n') }
    ]))
    merged = combined
    compressionPasses = 0
  }

  return complete([
    { role: 'system', content: summaryInstruction() },
    { role: 'user', content: prompt('summaryFinal', { text: merged[0] || '' }) }
  ], false, onText)
}
