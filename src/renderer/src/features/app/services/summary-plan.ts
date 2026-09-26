export const summaryChunks = (transcript: string, size = 24_000): string[] => {
  const chunks: string[] = []
  let remaining = transcript.trim()
  while (remaining.length > size) {
    const boundary = Math.max(remaining.lastIndexOf('\n', size), remaining.lastIndexOf('。', size), remaining.lastIndexOf('.', size))
    const end = boundary > size / 2 ? boundary + 1 : size
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export const summaryBatches = (partials: string[], size = 24_000): string[][] => {
  const batches: string[][] = []
  let batch: string[] = []
  let length = 0
  for (const partial of partials) {
    const addition = partial.length + (batch.length ? 7 : 0)
    if (batch.length && length + addition > size) {
      batches.push(batch)
      batch = []
      length = 0
    }
    batch.push(partial)
    length += addition
  }
  if (batch.length) batches.push(batch)
  return batches
}

export const transcriptSignature = (transcript: string): string => {
  let hash = 2_166_136_261
  for (let index = 0; index < transcript.length; index += 1) hash = Math.imul(hash ^ transcript.charCodeAt(index), 16_777_619)
  return `${transcript.length}:${(hash >>> 0).toString(36)}`
}
