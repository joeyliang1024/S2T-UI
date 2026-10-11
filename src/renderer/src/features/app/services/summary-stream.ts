export async function readSummaryStream(response: Response, onText: (text: string) => void): Promise<{ text: string }> {
  if (!response.body) throw new Error('Summary stream is unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''; let text = ''; let done = false
  const consume = (line: string): void => {
    if (!line.trim()) return
    const event = JSON.parse(line) as { delta?: string; error?: string; done?: boolean }
    if (event.error) throw new Error(event.error)
    if (typeof event.delta === 'string') { text += event.delta; onText(text) }
    if (event.done) done = true
  }
  try {
    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (chunk.done) break
    }
    consume(buffer)
    if (!done) throw new Error('Summary stream ended before completion')
    return { text }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
