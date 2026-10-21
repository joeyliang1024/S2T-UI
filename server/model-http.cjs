const { Agent, fetch: pooledFetch } = require('undici')
const { currentWorkload } = require('./workload-context.cjs')
const { cachedLookup } = require('./dns-lookup.cjs')
const { createAdaptiveCapacity } = require('./adaptive-capacity.cjs')
const pools = new Map()
const clients = new Map()
const createModelClient = (role, { apiKey, baseURL, timeout = 30000, maxRetries = 0 }) => {
  const key = JSON.stringify([role, apiKey, baseURL, timeout, maxRetries])
  let client = clients.get(key)
  if (client) clients.delete(key)
  else {
    const OpenAI = require('openai').default
    client = new OpenAI({ apiKey, baseURL, timeout, maxRetries, fetch: createModelFetch(role) })
  }
  clients.set(key, client)
  if (clients.size > 64) clients.delete(clients.keys().next().value)
  return client
}
const createModelFetch = role => {
  if (pools.has(role)) return pools.get(role).fetch
  const maximum = Number(process.env.S2T_MODEL_HTTP_MAX_CONNECTIONS || 512)
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2048) throw new Error('S2T_MODEL_HTTP_MAX_CONNECTIONS must be in 1..2048')
  const backgroundMaximum = Number(process.env.S2T_BACKGROUND_MAX_INFLIGHT || 8)
  if (!Number.isSafeInteger(backgroundMaximum) || backgroundMaximum < 1 || backgroundMaximum > 64) throw new Error('S2T_BACKGROUND_MAX_INFLIGHT must be in 1..64')
  const capacity = createAdaptiveCapacity({ minimum: Math.min(8, maximum), maximum, initial: Math.min(256, maximum), idleFloor: Math.min(256, maximum), growthMs: 250, healthyMs: 2000, backgroundMaximum, backgroundWaitMs: 60000 })
  // Sockets grow lazily under the adaptive admission window. Idle sockets are
  // retired quickly; in-flight requests/streams are never forcibly retired.
  const agent = new Agent({ connections: maximum, pipelining: 1, connect: { lookup: cachedLookup }, connectTimeout: 3000, keepAliveTimeout: 5000, keepAliveMaxTimeout: 10000, headersTimeout: 30000, bodyTimeout: 30000 })
  const modelFetch = async (input, init) => {
    const signal = init?.signal || (input instanceof Request ? input.signal : undefined)
    const workload = role === 'summaries' ? 'background' : currentWorkload()
    const returned = await capacity.acquire({ priority: workload, signal })
    const onAbort = () => release()
    const release = error => { signal?.removeEventListener('abort', onAbort); returned(signal?.aborted ? undefined : error) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) throw new DOMException('Model request aborted', 'AbortError')
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
      headers.set('x-s2t-workload', workload)
      const response = await pooledFetch(input, { ...init, headers, dispatcher: agent })
      const failure = response.status === 429 || response.status >= 500 ? new Error(`Model HTTP ${response.status}`) : undefined
      if (!response.body) { release(failure); return response }
      const reader = response.body.getReader()
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) { release(failure); controller.close() }
            else controller.enqueue(value)
          } catch (error) { release(error); controller.error(error) }
        },
        async cancel(reason) { try { await reader.cancel(reason) } finally { release(failure) } }
      })
      const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperty(result, 'url', { value: response.url })
      return result
    } catch (error) { release(error); throw error }
  }
  pools.set(role, { fetch: modelFetch, capacity, agent })
  return modelFetch
}
const modelHttpStats = () => Object.fromEntries([...pools].map(([role, pool]) => {
  const sockets = Object.values(pool.agent.stats)
  return [role, { ...pool.capacity.stats(), connections: sockets.reduce((sum, value) => sum + value.connected, 0), idleConnections: sockets.reduce((sum, value) => sum + value.free, 0), socketQueued: sockets.reduce((sum, value) => sum + value.queued, 0) }]
}))
const closeModelHttp = async () => {
  clients.clear()
  const entries = [...pools.values()]; pools.clear()
  for (const pool of entries) pool.capacity.close()
  await Promise.all(entries.map(pool => pool.agent.close()))
}
module.exports = { createModelFetch, createModelClient, modelHttpStats, closeModelHttp }
