const { createServer } = require('node:http')
const { readFile, stat } = require('node:fs/promises')
const { join, normalize } = require('node:path')
const { randomUUID } = require('node:crypto')
const OpenAI = require('openai').default
const { toFile } = require('openai')
const { config } = require('dotenv')
const { diarizeWav, extractSpeakerEmbedding, extractDiarizedSpeakerEmbeddings } = require('./sherpa-diarization.cjs')
const { createStorage } = require('./storage/index.cjs')
const { createAuth } = require('./auth/index.cjs')

config({ path: join(process.cwd(), '.env') })

const port = Number(process.env.S2T_WEB_PORT || 8787)
const maxAsrAudioBytes = 100 * 1024 * 1024
const service = (name) => ({
  endpoint: process.env[`S2T_${name}_ENDPOINT`] || process.env[`S2T_WEB_${name}_ENDPOINT`] || '',
  model: process.env[`S2T_${name}_MODEL`] || process.env[`S2T_WEB_${name}_MODEL`] || '',
  apiKey: process.env[`S2T_${name}_API_KEY`] || process.env[`S2T_WEB_${name}_API_KEY`] || ''
})
const asr = service('ASR')
const translation = service('TRANSLATION')
const summary = service('SUMMARY')
const diarization = service('DIARIZATION')
// Storage validates partial remote configuration at startup. Each independently
// configured service falls back to its local adapter only when all of its
// environment variables are absent.
const storage = createStorage(process.env)
const authReady = createAuth(storage, process.env)
const staticRoot = join(process.cwd(), 'out/renderer')
const allowedOrigins = new Set((process.env.S2T_WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean))
const requestsByIp = new Map()
const languageNames = { auto: '自动检测（中文、英语、日语或德语）', 'zh-TW': '繁体中文', 'en-US': '英语', en: '英语', 'ja-JP': '日语', ja: '日语', 'de-DE': '德语', de: '德语' }
const supportedTranslationSourceLanguages = new Set(['auto', 'zh-TW', 'en-US', 'ja-JP', 'de-DE'])
const supportedTranslationTargetLanguages = new Set(['zh-TW', 'en', 'ja', 'de'])
const hyLanguageName = (value) => languageNames[value] || '自动检测（中文、英语、日语或德语）'
const isChineseLanguage = (value) => /^zh/.test(value)
const hyTranslationPrompt = (text, sourceLanguage, targetLanguage, glossary) => {
  const terms = glossary ? `\n术语表：${glossary}` : ''
  return isChineseLanguage(sourceLanguage) || isChineseLanguage(targetLanguage)
    ? `以下输入只会是中文、英语、日语或德语。将其翻译为${hyLanguageName(targetLanguage)}；来源语言为${hyLanguageName(sourceLanguage)}。只输出译文，不要额外解释。${terms}\n\n${text}`
    : `The input is Chinese, English, Japanese, or German. Translate it into ${hyLanguageName(targetLanguage)}. The source language is ${hyLanguageName(sourceLanguage)}. Return only the translation.${terms}\n\n${text}`
}

const baseUrl = (value) => {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/(audio\/transcriptions|chat\/completions)\/?$/, '').replace(/\/$/, '')
  return url.toString().replace(/\/$/, '')
}
const publicService = (value, endpoint) => ({
  endpoint,
  model: value.model,
  configured: Boolean(value.endpoint && value.model && value.apiKey)
})
const completeText = async (value, messages) => {
  const client = new OpenAI({ apiKey: value.apiKey, baseURL: baseUrl(value.endpoint), timeout: 30_000, maxRetries: 1 })
  const result = await client.chat.completions.create({ model: value.model, temperature: 0.2, messages })
  return result.choices[0]?.message.content?.trim() || ''
}
const send = (response, status, body, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
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
const safeUploadFilename = (value) => {
  const name = typeof value === 'string' ? value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) : ''
  return name || 'audio.wav'
}
const safeAudioContentType = (value) => {
  const type = typeof value === 'string' ? value.toLowerCase().split(';', 1)[0].trim() : ''
  return /^audio\/(wav|x-wav|mpeg|mp4|aac|ogg|webm|flac)$/.test(type) || /^video\/(mp4|quicktime|webm)$/.test(type)
    ? type
    : 'application/octet-stream'
}
const voiceprintRecordKey = 'voiceprints'
const voiceprintThreshold = Math.max(0, Math.min(1, Number(process.env.S2T_VOICEPRINT_THRESHOLD || 0.65)))
const ownVoiceprints = async (user) => {
  const value = await storage.config.get(user.id, voiceprintRecordKey)
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && typeof item.createdAt === 'string') : []
}
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
const acceptsRequest = (request, bucket) => {
  const ip = request.socket.remoteAddress || 'unknown'
  const key = `${ip}:${bucket}`
  const now = Date.now()
  const recent = (requestsByIp.get(key) || []).filter((time) => now - time < 60_000)
  if (recent.length >= 60) return false
  recent.push(now)
  requestsByIp.set(key, recent)
  return true
}

createServer(async (request, response) => {
  const origin = request.headers.origin
  const host = request.headers.host || ''
  const sameOrigin = origin === `http://${host}` || origin === `https://${host}`
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) return send(response, 403, { error: 'Origin is not allowed.' })
  if (origin) response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'Origin')
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-s2t-language, x-s2t-prompt, x-s2t-filename' }); return response.end() }
  const auth = await authReady
  if (await auth.handle(request, response, send)) return
  if (request.method === 'GET' && request.url === '/api/config') return send(response, 200, {
    asr: publicService(asr, '/api/transcriptions'),
    translation: publicService(translation, '/api/translations'),
    summary: publicService(summary, '/api/summaries'),
    diarization: diarization.endpoint && diarization.model
      ? publicService(diarization, '/api/diarizations')
      : { endpoint: '/api/diarizations', model: 'sherpa-onnx-speaker-diarization', configured: true }
  })
  if (request.method === 'GET' && request.url === '/api/storage') {
    try { await storage.ready; return send(response, 200, { mode: storage.mode }) }
    catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'Storage is unavailable', mode: storage.mode }) }
  }
  const storagePath = new URL(request.url, 'http://localhost').pathname
  if (storagePath === '/api/data/sessions' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') return send(response, 200, { sessions: await storage.config.get(user.id, 'sessions') ?? [] })
      const body = JSON.parse((await readBody(request, 5 * 1024 * 1024)).toString('utf8'))
      if (!Array.isArray(body.sessions)) return send(response, 400, { error: 'sessions 必須是陣列' })
      await storage.config.put(user.id, 'sessions', body.sessions)
      return send(response, 200, { saved: true })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存紀錄' }) }
  }
  if (storagePath === '/api/data/glossary' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') return send(response, 200, { glossary: await storage.config.get(user.id, 'glossary') ?? '' })
      const body = JSON.parse((await readBody(request, 256 * 1024)).toString('utf8'))
      if (typeof body.glossary !== 'string') return send(response, 400, { error: 'glossary 必須是文字' })
      await storage.config.put(user.id, 'glossary', body.glossary.trim().slice(0, 20_000))
      return send(response, 200, { saved: true })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存術語' }) }
  }
  const audioMatch = storagePath.match(/^\/api\/data\/audio\/([A-Za-z0-9._-]{1,160})$/)
  if (audioMatch && ['GET', 'POST', 'DELETE'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const audioKey = `audio/${audioMatch[1]}`
    try {
      if (request.method === 'POST') { const audio = await readBody(request, 1024 * 1024 * 1024); if (!audio.length) return send(response, 400, { error: '音檔不可為空' }); await storage.blob.put(user.id, audioKey, audio); return send(response, 201, { saved: true }) }
      if (request.method === 'DELETE') { await storage.blob.remove(user.id, audioKey); return send(response, 204, '') }
      const audio = await storage.blob.get(user.id, audioKey); return audio ? send(response, 200, audio, 'audio/wav') : send(response, 404, { error: '找不到音檔' })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '音檔操作失敗' }) }
  }
  if (storagePath === '/api/voiceprints' && ['GET', 'POST'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') return send(response, 200, { voiceprints: await ownVoiceprints(user) })
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: '聲紋註冊需要 WAV 音檔' })
      const embedding = extractSpeakerEmbedding(audio)
      const id = `vp-${randomUUID()}`
      await storage.vector.upsert({ id, NT: user.NT, Department: user.Department, embedding })
      const existing = await ownVoiceprints(user)
      const entry = { id, createdAt: new Date().toISOString(), NT: user.NT, Department: user.Department, dimensions: embedding.length }
      await storage.config.put(user.id, voiceprintRecordKey, [...existing, entry])
      return send(response, 201, { voiceprint: entry })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '聲紋註冊失敗' }) }
  }
  const voiceprintMatch = storagePath.match(/^\/api\/voiceprints\/([A-Za-z0-9._-]{1,160})$/)
  if (voiceprintMatch && request.method === 'DELETE') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      const voiceprints = await ownVoiceprints(user)
      if (!voiceprints.some((item) => item.id === voiceprintMatch[1])) return send(response, 404, { error: '找不到此聲紋註冊資料' })
      await storage.vector.remove(voiceprintMatch[1])
      await storage.config.put(user.id, voiceprintRecordKey, voiceprints.filter((item) => item.id !== voiceprintMatch[1]))
      return send(response, 204, '')
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法刪除聲紋' }) }
  }
  if (storagePath === '/api/voiceprints/identify' && request.method === 'POST') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: '聲紋比對需要 WAV 音檔' })
      const matches = await storage.vector.nearest(extractSpeakerEmbedding(audio), 1)
      const candidate = matches[0]
      return send(response, 200, { threshold: voiceprintThreshold, match: candidate && candidate.score >= voiceprintThreshold ? candidate : null })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '聲紋比對失敗' }) }
  }
  if (request.method === 'POST' && request.url === '/api/transcriptions') {
    if (!acceptsRequest(request, 'transcriptions')) return send(response, 429, { error: 'Too many transcription requests. Try again in one minute.' })
    if (!asr.endpoint || !asr.model || !asr.apiKey) return send(response, 503, { error: 'Web ASR gateway has not been configured.' })
    try {
      const audio = await readBody(request, maxAsrAudioBytes)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      const client = new OpenAI({ apiKey: asr.apiKey, baseURL: baseUrl(asr.endpoint), timeout: 20_000, maxRetries: 1 })
      const result = await client.audio.transcriptions.create({
        file: await toFile(audio, safeUploadFilename(request.headers['x-s2t-filename']), { type: safeAudioContentType(request.headers['content-type']) }), model: asr.model,
        ...(['zh', 'en', 'ja', 'de'].includes(String(request.headers['x-s2t-language'] || '')) ? { language: String(request.headers['x-s2t-language']) } : {}),
        ...(request.headers['x-s2t-prompt'] ? { prompt: String(request.headers['x-s2t-prompt']).slice(0, 10_000) } : {})
      })
      return send(response, 200, { text: result.text || '' })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'ASR request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/translations') {
    if (!acceptsRequest(request, 'translations')) return send(response, 429, { error: 'Too many translation requests. Try again in one minute.' })
    if (!translation.endpoint || !translation.model || !translation.apiKey) return send(response, 503, { error: 'Web translation gateway has not been configured.' })
    try {
      const raw = await readBody(request, 256 * 1024)
      const input = JSON.parse(raw.toString('utf8'))
      const text = typeof input.text === 'string' ? input.text.trim().slice(0, 20_000) : ''
      const requestedSourceLanguage = typeof input.sourceLanguage === 'string' ? input.sourceLanguage.slice(0, 60) : 'zh-TW'
      const requestedTargetLanguage = typeof input.targetLanguage === 'string' ? input.targetLanguage.slice(0, 60) : 'en'
      const sourceLanguage = supportedTranslationSourceLanguages.has(requestedSourceLanguage) ? requestedSourceLanguage : 'zh-TW'
      const targetLanguage = supportedTranslationTargetLanguages.has(requestedTargetLanguage) ? requestedTargetLanguage : 'en'
      const glossary = typeof input.glossary === 'string' ? input.glossary.trim().slice(0, 10_000) : ''
      if (!text) return send(response, 400, { error: 'Text is required.' })
      const textResult = await completeText(translation, [{ role: 'user', content: hyTranslationPrompt(text, sourceLanguage, targetLanguage, glossary) }])
      return send(response, 200, { text: textResult })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Translation request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/summaries') {
    if (!acceptsRequest(request, 'summaries')) return send(response, 429, { error: 'Too many summary requests. Try again in one minute.' })
    if (!summary.endpoint || !summary.model || !summary.apiKey) return send(response, 503, { error: 'Web summary gateway has not been configured.' })
    try {
      const input = JSON.parse((await readBody(request, 256 * 1024)).toString('utf8'))
      const messages = Array.isArray(input.messages) ? input.messages.filter((item) => item && (item.role === 'system' || item.role === 'user') && typeof item.content === 'string').slice(0, 8) : []
      if (!messages.length) return send(response, 400, { error: 'Messages are required.' })
      return send(response, 200, { text: await completeText(summary, messages) })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Summary request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/diarizations') {
    if (!acceptsRequest(request, 'diarizations')) return send(response, 429, { error: 'Too many diarization requests. Try again in one minute.' })
    try {
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      if (diarization.endpoint && diarization.model) {
        if (!diarization.apiKey) return send(response, 503, { error: 'Web diarization gateway has not been configured.' })
        const form = new FormData()
        form.set('model', diarization.model)
        form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
        const remote = await fetch(diarization.endpoint, { method: 'POST', headers: { authorization: `Bearer ${diarization.apiKey}` }, body: form, signal: AbortSignal.timeout(120_000) })
        const body = await remote.text()
        if (!remote.ok) return send(response, remote.status, { error: body || `HTTP ${remote.status}` })
        return send(response, 200, body)
      }
      const segments = diarizeWav(audio)
      const recognized = new Map()
      for (const item of extractDiarizedSpeakerEmbeddings(audio, segments)) {
        const candidate = (await storage.vector.nearest(item.embedding, 1))[0]
        if (candidate?.score >= voiceprintThreshold) recognized.set(item.speaker, candidate)
      }
      const labeledSegments = segments.map((segment) => {
        const match = recognized.get(segment.speaker)
        return match ? { ...segment, speaker: match.NT, Department: match.Department, matchScore: match.score } : segment
      })
      return send(response, 200, { model: 'sherpa-onnx-speaker-diarization', threshold: voiceprintThreshold, exclusive_diarization: labeledSegments })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Speaker diarization failed' })
    }
  }
  return staticFile(request, response)
}).listen(port, '127.0.0.1', () => console.log(`S2T web gateway: http://127.0.0.1:${port}`))
