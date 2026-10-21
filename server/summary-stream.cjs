const { createModelClient } = require('./model-http.cjs')
async function streamSummary(request, response, value, messages, baseURL, observe) {
  const client = createModelClient('summaries', { apiKey: value.apiKey, baseURL, timeout: 30_000, maxRetries: 0 })
  const abort = new AbortController()
  const close = () => { if (!response.writableEnded) abort.abort() }
  response.on('close', close)
  let text = ''; let usage
  try {
    const stream = await client.chat.completions.create({ model: value.model, temperature: 0.2, messages, stream: true, stream_options: { include_usage: true } }, { signal: abort.signal })
    response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' })
    response.flushHeaders()
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage
      const delta = chunk.choices[0]?.delta?.content
      if (delta) { text += delta; response.write(JSON.stringify({ delta }) + '\n') }
    }
    if (observe) observe(text, usage)
    response.end(JSON.stringify({ done: true }) + '\n')
  } catch (error) {
    if (response.destroyed) return
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/x-ndjson; charset=utf-8' })
    response.end(JSON.stringify({ error: error.message || 'Summary stream failed' }) + '\n')
  } finally { response.off('close', close) }
}
module.exports = { streamSummary }
