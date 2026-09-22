const { createServer } = require('node:http')
const { readFile, stat } = require('node:fs/promises')
const { join, normalize } = require('node:path')
const OpenAI = require('openai').default
const { toFile } = require('openai')
const { config } = require('dotenv')
const { diarizeWav } = require('./sherpa-diarization.cjs')

config({ path: join(process.cwd(), '.env') })

const port = Number(process.env.S2T_WEB_PORT || 8787)
const endpoint = process.env.S2T_WEB_ASR_ENDPOINT || process.env.S2T_ASR_ENDPOINT || ''
const model = process.env.S2T_WEB_ASR_MODEL || process.env.S2T_ASR_MODEL || ''
const apiKey = process.env.S2T_WEB_ASR_API_KEY || process.env.S2T_ASR_API_KEY || ''
const publicName = process.env.S2T_WEB_ASR_NAME || model || '未設定 ASR 模型'
const staticRoot = join(process.cwd(), 'out/renderer')
const allowedOrigins = new Set((process.env.S2T_WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean))
const requestsByIp = new Map()

const baseUrl = (value) => {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/audio\/transcriptions\/?$/, '').replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}
const send = (response, status, body, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const readBody = (request, maximum = 12 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > maximum) { request.destroy(); reject(new Error(`音訊資料超過 ${Math.round(maximum / 1024 / 1024)} MB`)) } else chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', reject)
})
const staticFile = async (request, response) => {
  const urlPath = new URL(request.url, 'http://localhost').pathname
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '')
  const filePath = join(staticRoot, normalize(requested).replace(/^\.\.(\/|\\|$)/, ''))
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    const content = await readFile(filePath)
    const type = filePath.endsWith('.js') ? 'text/javascript' : filePath.endsWith('.css') ? 'text/css' : filePath.endsWith('.html') ? 'text/html' : 'application/octet-stream'
    send(response, 200, content, type)
  } catch {
    try { send(response, 200, await readFile(join(staticRoot, 'index.html')), 'text/html') } catch { send(response, 404, { error: 'Web build not found. Run npm run build first.' }) }
  }
}
const acceptsRequest = (request) => {
  const ip = request.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const recent = (requestsByIp.get(ip) || []).filter((time) => now - time < 60_000)
  if (recent.length >= 60) return false
  recent.push(now)
  requestsByIp.set(ip, recent)
  return true
}

createServer(async (request, response) => {
  const origin = request.headers.origin
  const host = request.headers.host || ''
  const sameOrigin = origin === `http://${host}` || origin === `https://${host}`
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) return send(response, 403, { error: 'Origin is not allowed.' })
  if (origin) response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'Origin')
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-s2t-language, x-s2t-prompt' }); return response.end() }
  if (request.method === 'GET' && request.url === '/api/config') return send(response, 200, { configured: Boolean(endpoint && model && apiKey), model: endpoint && model ? { id: 'web-environment-asr', name: publicName, model, kind: 'openai-http' } : null })
  if (request.method === 'POST' && request.url === '/api/transcriptions') {
    if (!acceptsRequest(request)) return send(response, 429, { error: 'Too many transcription requests. Try again in one minute.' })
    if (!endpoint || !model || !apiKey) return send(response, 503, { error: 'Web ASR gateway has not been configured.' })
    try {
      const audio = await readBody(request)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      const client = new OpenAI({ apiKey, baseURL: baseUrl(endpoint), timeout: 20_000, maxRetries: 1 })
      const result = await client.audio.transcriptions.create({
        file: await toFile(audio, 'live-chunk.wav', { type: 'audio/wav' }), model,
        language: String(request.headers['x-s2t-language'] || 'zh').slice(0, 40),
        ...(request.headers['x-s2t-prompt'] ? { prompt: String(request.headers['x-s2t-prompt']).slice(0, 10_000) } : {})
      })
      return send(response, 200, { text: result.text || '' })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'ASR request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/diarizations') {
    if (!acceptsRequest(request)) return send(response, 429, { error: 'Too many diarization requests. Try again in one minute.' })
    try {
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      const segments = diarizeWav(audio)
      return send(response, 200, { model: 'sherpa-onnx-speaker-diarization', exclusive_diarization: segments })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Speaker diarization failed' })
    }
  }
  return staticFile(request, response)
}).listen(port, () => console.log(`S2T web gateway: http://127.0.0.1:${port}`))
