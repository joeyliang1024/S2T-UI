const { createServer } = require('node:http')
const { readFile, stat } = require('node:fs/promises')
const { join, normalize, basename } = require('node:path')
const { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto')
const OpenAI = require('openai').default
const { toFile } = require('openai')
const { config } = require('dotenv')
const { diarizeWav, extractSpeakerEmbedding, extractDiarizedSpeakerEmbeddings, assessVoiceprintSample, modelPaths, sherpaWorkerPool, analyzeSileroVad, audioPreprocessStatus, dynaudnormWav } = require('./sherpa-worker-pool.cjs')
const { findIdentityCandidates } = require('./voiceprint-matching.cjs')
const { createStorage } = require('./storage/index.cjs')
const { createAuth } = require('./auth/index.cjs')

config({ path: join(process.cwd(), '.env') })

const port = Number(process.env.S2T_WEB_PORT || 8787)
const processRole = process.env.S2T_PROCESS_ROLE || 'all'
if (!['all', 'api', 'audio-worker'].includes(processRole)) throw new Error('S2T_PROCESS_ROLE 必須是 all、api 或 audio-worker')
const maxAsrAudioBytes = 100 * 1024 * 1024
const service = (name) => ({
  endpoint: process.env[`S2T_${name}_ENDPOINT`] || process.env[`S2T_WEB_${name}_ENDPOINT`] || '',
  model: process.env[`S2T_${name}_MODEL`] || process.env[`S2T_WEB_${name}_MODEL`] || '',
  apiKey: process.env[`S2T_${name}_API_KEY`] || process.env[`S2T_WEB_${name}_API_KEY`] || ''
})
const asr = service('ASR')
const configuredAsrProfiles = (() => {
  const fallback = { id: 'default', name: asr.model || 'Environment ASR', ...asr }
  const raw = process.env.S2T_WEB_ASR_MODELS_JSON || ''
  if (!raw.trim()) return [fallback]
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [fallback]
    const profiles = parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(item.id) ? item.id : ''
      const endpoint = typeof item.endpoint === 'string' ? item.endpoint.trim() : ''
      const model = typeof item.model === 'string' ? item.model.trim() : ''
      const apiKey = typeof item.apiKey === 'string' ? item.apiKey.trim() : ''
      if (!id || !endpoint || !model || !apiKey) return []
      return [{ id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : model, endpoint, model, apiKey }]
    })
    return profiles.length ? profiles : [fallback]
  } catch { return [fallback] }
})()
const asrProfileById = new Map(configuredAsrProfiles.map((profile) => [profile.id, profile]))
const translation = service('TRANSLATION')
const summary = service('SUMMARY')
const diarization = service('DIARIZATION')
// Storage validates partial remote configuration at startup. Each independently
// configured service falls back to its local adapter only when all of its
// environment variables are absent.
const storage = createStorage(process.env)
if (process.env.S2T_KUBERNETES_MODE === 'true' && Object.values(storage.mode).some((mode) => mode === 'local')) throw new Error('Kubernetes 模式必須設定共享 MinIO、PostgreSQL 與 Milvus，不能使用 Pod 本地 storage')
const authReady = createAuth(storage, process.env)
const staticRoot = join(process.cwd(), 'out/renderer')
const allowedOrigins = new Set((process.env.S2T_WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean))
const requestsByIp = new Map()
const modelHealthChecks = new Map()
const requestLimits = { transcriptions: 60, translations: 30, summaries: 12, diarizations: 8 }
const requestLatency = new Map()
const latencyBuckets = [.25, .5, 1, 2.5, 5, 10]
const observeRequest = (path, status, startedAt) => {
  if (!['/api/transcriptions', '/api/translations', '/api/diarizations', '/api/audio-processing/silero-vad'].includes(path)) return
  const metric = requestLatency.get(path) || { count: 0, errors: 0, sum: 0, buckets: latencyBuckets.map(() => 0) }
  const seconds = Math.max(0, (performance.now() - startedAt) / 1000)
  metric.count += 1; metric.sum += seconds; if (status >= 400) metric.errors += 1
  latencyBuckets.forEach((upper, index) => { if (seconds <= upper) metric.buckets[index] += 1 })
  requestLatency.set(path, metric)
}
const prometheusMetrics = () => {
  const lines = ['# HELP s2t_gateway_request_duration_seconds Gateway request duration.', '# TYPE s2t_gateway_request_duration_seconds histogram']
  for (const [path, metric] of requestLatency) {
    const route = path.replace(/^\/api\//, '').replace(/[^A-Za-z0-9_]/g, '_')
    latencyBuckets.forEach((upper, index) => lines.push(`s2t_gateway_request_duration_seconds_bucket{route="${route}",le="${upper}"} ${metric.buckets[index]}`))
    lines.push(`s2t_gateway_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${metric.count}`)
    lines.push(`s2t_gateway_request_duration_seconds_sum{route="${route}"} ${metric.sum}`)
    lines.push(`s2t_gateway_request_duration_seconds_count{route="${route}"} ${metric.count}`)
    lines.push(`s2t_gateway_request_errors_total{route="${route}"} ${metric.errors}`)
  }
  const worker = sherpaWorkerPool.stats()
  lines.push('# HELP s2t_sherpa_worker_jobs Current sherpa worker pool jobs.', '# TYPE s2t_sherpa_worker_jobs gauge')
  for (const [state, value] of Object.entries(worker)) lines.push(`s2t_sherpa_worker_jobs{state="${state}"} ${value}`)
  return `${lines.join('\n')}\n`
}
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
const publicAsrProfile = (value) => ({ id: value.id, name: value.name, endpoint: '/api/transcriptions', model: value.model, configured: Boolean(value.endpoint && value.model && value.apiKey) })
const normalizeDetectedLanguage = (value) => {
  if (typeof value !== 'string') return undefined
  const language = value.toLowerCase()
  if (language.startsWith('zh')) return 'zh-TW'
  if (language.startsWith('en')) return 'en-US'
  if (language.startsWith('ja')) return 'ja-JP'
  if (language.startsWith('de')) return 'de-DE'
  return undefined
}
const completeText = async (value, messages) => {
  const client = new OpenAI({ apiKey: value.apiKey, baseURL: baseUrl(value.endpoint), timeout: 30_000, maxRetries: 1 })
  const result = await client.chat.completions.create({ model: value.model, temperature: 0.2, messages })
  return result.choices[0]?.message.content?.trim() || ''
}
const credentialKey = (secret) => createHash('sha256').update(`${secret}:s2t-model-credentials:v1`).digest()
const encryptCredential = (secret, plaintext) => {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', credentialKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]); const tag = cipher.getAuthTag()
  return { v: 1, iv: iv.toString('base64url'), tag: tag.toString('base64url'), ciphertext: ciphertext.toString('base64url') }
}
const decryptCredential = (secret, value) => {
  if (!value || typeof value !== 'object' || value.v !== 1 || typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.ciphertext !== 'string') return ''
  const decipher = createDecipheriv('aes-256-gcm', credentialKey(secret), Buffer.from(value.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
}
const validCredentialId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const accountModelService = async (auth, user, id, purpose) => {
  const registry = await storage.config.get(user.id, 'model-registry')
  const model = Array.isArray(registry?.models) ? registry.models.find((item) => item?.id === id && item?.purpose === purpose) : undefined
  if (!model || !model.endpoint || !model.model) return null
  let apiKey = ''
  if (model.requiresApiKey !== false) {
    const encrypted = await storage.config.get(user.id, `model-credential-${id}`)
    apiKey = decryptCredential(auth.secret, encrypted)
    if (!apiKey) return null
  }
  return { endpoint: model.endpoint, model: model.model, apiKey }
}
const modelHealth = async (auth, user, model) => {
  const key = `${user.id}:${model.id}`
  const cached = modelHealthChecks.get(key)
  const now = Date.now()
  if (cached?.value && now - cached.value.checkedAt < 60_000) return cached.value
  if (cached?.pending) return cached.pending
  const pending = (async () => {
    const service = await accountModelService(auth, user, model.id, model.purpose)
    const checkedAt = Date.now()
    if (!service) return { id: model.id, state: 'unknown', reason: model.requiresApiKey === false ? '模型設定不完整' : '尚未保存可用 API key', checkedAt }
    try {
      const root = baseUrl(service.endpoint)
      const probe = await fetch(`${root}/models`, { headers: service.apiKey ? { authorization: `Bearer ${service.apiKey}` } : {}, signal: AbortSignal.timeout(8_000) })
      if (!probe.ok) return { id: model.id, state: 'unhealthy', reason: `模型服務 HTTP ${probe.status}`, checkedAt }
      const body = await probe.json().catch(() => ({}))
      const available = Array.isArray(body?.data) && body.data.some((item) => item?.id === service.model)
      return { id: model.id, state: available ? 'healthy' : 'degraded', reason: available ? '服務與指定模型均可用' : '服務可達，但未確認指定模型', checkedAt }
    } catch (error) { return { id: model.id, state: 'unhealthy', reason: error instanceof Error ? error.message.slice(0, 160) : '無法連線至模型服務', checkedAt } }
  })()
  modelHealthChecks.set(key, { pending })
  try { const value = await pending; modelHealthChecks.set(key, { value }); return value } finally { const current = modelHealthChecks.get(key); if (current?.pending === pending) modelHealthChecks.delete(key) }
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
    : ''
}
const voiceprintRecordKey = 'voiceprints'
const voiceprintCompensationKey = 'voiceprint-compensations'
const audioCompensationKey = 'audio-compensations'
const voiceprintThreshold = Math.max(0, Math.min(1, Number(process.env.S2T_VOICEPRINT_THRESHOLD || 0.65)))
// A high best score alone is insufficient when two enrolled voices are close.
// Keep ambiguous turns anonymous instead of confidently assigning the wrong NT.
const voiceprintMargin = Math.max(0, Math.min(1, Number(process.env.S2T_VOICEPRINT_MARGIN || 0.05)))
const voiceprintEmbeddingMetadata = () => ({ model: process.env.S2T_VOICEPRINT_EMBEDDING_MODEL_NAME || basename(modelPaths().embedding), version: process.env.S2T_VOICEPRINT_EMBEDDING_VERSION || 'sherpa-onnx-v1' })
const ownVoiceprints = async (user) => {
  const value = await storage.config.get(user.id, voiceprintRecordKey)
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && typeof item.createdAt === 'string') : []
}
const pendingVoiceprintCompensations = async (user) => {
  const value = await storage.config.get(user.id, voiceprintCompensationKey)
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && (item.type === 'enroll-cleanup' || item.type === 'delete')) : []
}
const saveVoiceprintCompensations = (user, items) => storage.config.put(user.id, voiceprintCompensationKey, items)
const reconcileVoiceprintCompensations = async (user) => {
  const pending = await pendingVoiceprintCompensations(user)
  if (!pending.length) return
  const current = await ownVoiceprints(user)
  const retained = []
  for (const item of pending) {
    try {
      if (item.type === 'enroll-cleanup') {
        await storage.vector.remove(item.id)
        if (typeof storage.config.removeVoiceprint === 'function') await storage.config.removeVoiceprint(item.id, user.id)
        await storage.config.put(user.id, voiceprintRecordKey, (await ownVoiceprints(user)).filter((entry) => entry.id !== item.id))
      } else {
        await storage.vector.remove(item.id)
        if (typeof storage.config.removeVoiceprint === 'function') await storage.config.removeVoiceprint(item.id, user.id)
        await storage.config.put(user.id, voiceprintRecordKey, (await ownVoiceprints(user)).filter((entry) => entry.id !== item.id))
      }
    } catch { retained.push(item) }
  }
  if (retained.length !== pending.length || !retained.length) await saveVoiceprintCompensations(user, retained)
}
const audioKeysInSessions = (sessions) => new Set(sessions.flatMap((session) => [session?.audioKey, ...(Array.isArray(session?.audioVersions) ? session.audioVersions.map((version) => version?.audioKey) : [])]).filter((key) => typeof key === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(key)))
const canonicalSessions = (sessions) => {
  const ids = new Set(); const audio = new Set(); const result = []
  for (const session of sessions) {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id.trim()) continue
    const id = session.id.replace(/(?:-remote-[a-f0-9]+)+$/i, '')
    const active = Array.isArray(session.audioVersions) ? session.audioVersions.find((version) => version?.id === session.activeAudioVersionId) : null
    const audioKey = typeof active?.audioKey === 'string' ? active.audioKey : typeof session.audioKey === 'string' ? session.audioKey : ''
    // A retry may arrive from another pod after a client reconnect. Keep the
    // first record (the renderer orders newest first) rather than minting a
    // historical conflict copy for the same immutable audio object.
    if (ids.has(id) || (audioKey && audio.has(audioKey))) continue
    ids.add(id); if (audioKey) audio.add(audioKey)
    result.push({ ...session, id, title: typeof session.title === 'string' ? session.title.replace(/（遠端衝突版本）+$/u, '') : session.title })
  }
  return result
}
const pendingAudioCompensations = async (user) => {
  const value = await storage.config.get(user.id, audioCompensationKey)
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(item.id)) : []
}
const reconcileAudioCompensations = async (user, sessions) => {
  const pending = await pendingAudioCompensations(user)
  if (!pending.length) return
  const referenced = audioKeysInSessions(sessions)
  const retained = []
  for (const item of pending) {
    if (referenced.has(item.id)) continue
    try { await storage.blob.remove(user.id, `audio/${item.id}`) } catch { retained.push(item) }
  }
  await storage.config.put(user.id, audioCompensationKey, retained)
}
const orphanAudioKeys = async (user, sessions) => {
  if (typeof storage.blob.list !== 'function') return []
  const referenced = audioKeysInSessions(sessions)
  const pending = new Set((await pendingAudioCompensations(user)).map((item) => item.id))
  const keys = await storage.blob.list(user.id, 'audio')
  return keys.flatMap((key) => {
    const match = /^audio\/([A-Za-z0-9._-]{1,160})$/.exec(key)
    return match && !referenced.has(match[1]) && !pending.has(match[1]) ? [match[1]] : []
  })
}
const ownVoiceprintIds = async (user) => {
  const metadata = voiceprintEmbeddingMetadata()
  // Vector dimensions alone do not establish compatibility. Records created
  // before model/version metadata are deliberately excluded until re-enrolled.
  return (await ownVoiceprints(user)).filter((item) => item.embeddingModel === metadata.model && item.embeddingVersion === metadata.version).map((item) => item.id)
}
const visibleVoiceprintIds = async (user) => {
  const metadata = voiceprintEmbeddingMetadata()
  if (typeof storage.config.findVisibleVoiceprintIds === 'function') return storage.config.findVisibleVoiceprintIds({ userId: user.id, department: user.Department, embeddingModel: metadata.model, embeddingVersion: metadata.version })
  return ownVoiceprintIds(user)
}
const diarizationTurns = (payload) => {
  if (!payload || typeof payload !== 'object') return []
  const values = payload.exclusive_diarization ?? payload.segments ?? payload.diarization ?? []
  if (!Array.isArray(values)) return []
  return values.flatMap((item) => {
    if (!item || typeof item !== 'object' || typeof item.speaker !== 'string') return []
    const start = typeof item.start === 'number' ? item.start : typeof item.start_ms === 'number' ? item.start_ms / 1000 : NaN
    const end = typeof item.end === 'number' ? item.end : typeof item.end_ms === 'number' ? item.end_ms / 1000 : NaN
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end, speaker: item.speaker.trim() }] : []
  })
}
const labelDiarizationTurns = async (user, audio, turns) => {
  const recognized = new Map()
  const allowedVoiceprintIds = await visibleVoiceprintIds(user)
  for (const item of await extractDiarizedSpeakerEmbeddings(audio, turns)) {
    const candidates = await findIdentityCandidates(storage.vector, item.embedding, allowedVoiceprintIds)
    const candidate = candidates[0]
    const runnerUp = candidates[1]
    if (candidate?.score >= voiceprintThreshold && (!runnerUp || candidate.score - runnerUp.score >= voiceprintMargin)) recognized.set(item.speaker, candidate)
  }
  return turns.map((turn) => {
    const match = recognized.get(turn.speaker)
    return match ? { ...turn, speaker: match.NT, Department: match.Department, matchScore: match.score } : turn
  })
}
const runDurableDiarizationJob = async (auth, owner) => {
  if (typeof storage.config.claimDiarizationJob !== 'function') return
  const job = await storage.config.claimDiarizationJob(owner)
  if (!job) return
  try {
    const user = job.payload?.user
    if (!user?.id || user.id !== job.userId) throw new Error('工作使用者資料無效')
    const selected = await accountModelService(auth, user, job.payload?.modelId || 'managed-diarization', 'diarization')
    if (!selected?.endpoint || !selected.model) throw new Error('講者分離模型尚未設定')
    const audio = await storage.blob.get(user.id, `audio/${job.audioKey}`)
    if (!audio) throw new Error('找不到講者分離工作對應的音檔')
    const headers = selected.apiKey ? { authorization: `Bearer ${selected.apiKey}` } : {}
    const form = new FormData(); form.set('model', selected.model); form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
    const remote = await fetch(selected.endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(120_000) })
    const payload = await remote.json().catch(() => null)
    if (!remote.ok || !payload) throw new Error(`講者分離服務 HTTP ${remote.status}`)
    const turns = await labelDiarizationTurns(user, audio, diarizationTurns(payload))
    if (!turns.length) throw new Error('講者分離服務沒有回傳有效區段')
    const stored = await storage.config.get(user.id, 'sessions')
    const sessions = Array.isArray(stored?.sessions) ? stored.sessions : []
    const version = Number.isSafeInteger(stored?.version) ? stored.version : 0
    let matched = false
    const next = sessions.map((session) => {
      if (session?.id !== job.sessionId || session?.activeAudioVersionId && !session.audioVersions?.some((item) => item.id === session.activeAudioVersionId && item.audioKey === job.audioKey)) return session
      matched = true
      const segments = Array.isArray(session.segments) ? session.segments.map((entry) => {
        if (entry?.status !== 'final' || entry.speakerManuallyEdited) return entry
        let winner; let amount = 0
        for (const turn of turns) { const shared = Math.max(0, Math.min(entry.endMs, turn.end * 1000) - Math.max(entry.startMs, turn.start * 1000)); if (shared > amount) { amount = shared; winner = turn } }
        return winner && amount / Math.max(1, entry.endMs - entry.startMs) >= .35 ? { ...entry, speaker: winner.speaker, Department: winner.Department, revision: (entry.revision || 0) + 1 } : entry
      }) : []
      const transcript = segments.map((entry) => `${entry.speaker ? `${entry.speaker}：` : ''}${entry.sourceText || ''}`).filter(Boolean).join('\n')
      return { ...session, segments, transcript }
    })
    if (!matched) throw new Error('retry:紀錄尚未同步完成')
    // A pod can be terminated while inference is in flight.  Never let a
    // worker whose five-minute lease has expired write an older result over
    // the worker that took over the same durable job.
    if (!await storage.config.stillOwnsDiarizationJob(job.id, owner, job.leaseGeneration)) return
    if (!await storage.config.compareAndSwap(user.id, 'sessions', version, { sessions: next, version: version + 1 })) throw new Error('retry:紀錄已更新，背景工作將重試')
    await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration)
  } catch (error) { await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration, error instanceof Error ? error.message : '背景講者分離失敗') }
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
  const limit = requestLimits[bucket] ?? 30
  if (recent.length >= limit) return { accepted: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000)) }
  recent.push(now)
  requestsByIp.set(key, recent)
  return { accepted: true, retryAfterSeconds: 0 }
}
const rateLimitResponse = (response, result, message) => {
  response.setHeader('retry-after', String(result.retryAfterSeconds))
  return send(response, 429, { error: message, retryAfterSeconds: result.retryAfterSeconds })
}

let acceptingDiarizationJobs = true
let activeDiarizationJob = null
if (processRole !== 'api' && typeof storage.config.claimDiarizationJob === 'function') {
  const owner = `gateway-${randomUUID()}`
  authReady.then((auth) => {
    const drain = () => {
      if (!acceptingDiarizationJobs || activeDiarizationJob) return
      activeDiarizationJob = runDurableDiarizationJob(auth, owner)
        .catch(() => undefined)
        .finally(() => { activeDiarizationJob = null })
    }
    drain()
    setInterval(drain, 2_000).unref()
  }).catch(() => undefined)
}

const httpServer = createServer(async (request, response) => {
  // Liveness is intentionally independent of every downstream service. It
  // lets Kubernetes restart a stuck Node process without amplifying a storage
  // outage. Readiness below verifies the shared durable state instead.
  if (request.method === 'GET' && request.url === '/livez') return send(response, 200, { live: true, role: processRole })
  if (request.method === 'GET' && request.url === '/metrics') return send(response, 200, prometheusMetrics(), 'text/plain; version=0.0.4; charset=utf-8')
  if (request.method === 'GET' && request.url === '/readyz') {
    try { await storage.ready; await authReady; return send(response, 200, { ready: true, role: processRole, storage: storage.mode }) }
    catch (error) { return send(response, 503, { ready: false, role: processRole, error: error instanceof Error ? error.message : 'storage 尚未就緒' }) }
  }
  // The worker has a probe-only HTTP surface. It deliberately cannot serve
  // authenticated API traffic, but Kubernetes can still restart it when its
  // process or shared durable dependencies are unhealthy.
  if (processRole === 'audio-worker') return send(response, 404, { error: 'audio worker only exposes health probes' })
  const origin = request.headers.origin
  const host = request.headers.host || ''
  const sameOrigin = origin === `http://${host}` || origin === `https://${host}`
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) return send(response, 403, { error: 'Origin is not allowed.' })
  if (origin) { response.setHeader('access-control-allow-origin', origin); response.setHeader('access-control-allow-credentials', 'true') }
  response.setHeader('vary', 'Origin')
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-s2t-language, x-s2t-model-id, x-s2t-prompt, x-s2t-filename, x-s2t-dynaudnorm, x-s2t-voiceprint-sharing, x-s2t-voiceprint-consent', 'access-control-allow-credentials': 'true' }); return response.end() }
  const auth = await authReady
  const requestPath = new URL(request.url, 'http://localhost').pathname
  const startedAt = performance.now()
  response.once('finish', () => observeRequest(requestPath, response.statusCode, startedAt))
  if (await auth.handle(request, response, send)) return
  if (request.method === 'GET' && request.url === '/api/config') return send(response, 200, {
    asr: publicService(asr, '/api/transcriptions'),
    asrProfiles: configuredAsrProfiles.map(publicAsrProfile),
    translation: publicService(translation, '/api/translations'),
    summary: publicService(summary, '/api/summaries'),
    diarization: diarization.endpoint && diarization.model
      ? publicService(diarization, '/api/diarizations')
      : { endpoint: '/api/diarizations', model: 'sherpa-onnx-speaker-diarization', configured: true }
  })
  if (request.method === 'GET' && request.url === '/api/storage') {
    try { await storage.ready; return send(response, 200, { mode: storage.mode, schemaVersion: storage.schemaVersion, ready: true }) }
    catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'Storage is unavailable', mode: storage.mode, schemaVersion: storage.schemaVersion, ready: false }) }
  }
  const storagePath = new URL(request.url, 'http://localhost').pathname
  if (storagePath === '/api/data/storage-status' && request.method === 'GET') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      await reconcileVoiceprintCompensations(user)
      return send(response, 200, { audioPending: (await pendingAudioCompensations(user)).length, voiceprintPending: (await pendingVoiceprintCompensations(user)).length })
    } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : '無法讀取 storage 補償狀態' }) }
  }
  if (storagePath === '/api/data/storage-retry' && request.method === 'POST') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      await reconcileVoiceprintCompensations(user)
      const stored = await storage.config.get(user.id, 'sessions')
      const sessions = Array.isArray(stored?.sessions) ? stored.sessions : []
      await reconcileAudioCompensations(user, sessions)
      return send(response, 200, { retried: true, audioPending: (await pendingAudioCompensations(user)).length, voiceprintPending: (await pendingVoiceprintCompensations(user)).length })
    } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'storage 補償重試失敗' }) }
  }
  if (storagePath === '/api/data/storage-audit' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      const stored = await storage.config.get(user.id, 'sessions')
      const sessions = Array.isArray(stored?.sessions) ? stored.sessions : []
      const orphans = await orphanAudioKeys(user, sessions)
      if (request.method === 'POST') await Promise.all(orphans.map((id) => storage.blob.remove(user.id, `audio/${id}`)))
      return send(response, 200, { orphanAudio: request.method === 'POST' ? 0 : orphans.length, deletedAudio: request.method === 'POST' ? orphans.length : 0 })
    } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : '無法稽核 storage 音檔' }) }
  }
  if (storagePath === '/api/data/sessions' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') {
        const stored = await storage.config.get(user.id, 'sessions')
        const value = Array.isArray(stored) ? { sessions: stored, version: 0 } : stored
        return send(response, 200, value && Array.isArray(value.sessions) && Number.isSafeInteger(value.version) ? value : { sessions: [], version: 0 })
      }
      const body = JSON.parse((await readBody(request, 5 * 1024 * 1024)).toString('utf8'))
      if (!Array.isArray(body.sessions) || !Number.isSafeInteger(body.version) || body.version < 0) return send(response, 400, { error: 'sessions 與 version 必須有效' })
      const stored = await storage.config.get(user.id, 'sessions')
      const previousSessions = Array.isArray(stored?.sessions) ? stored.sessions : Array.isArray(stored) ? stored : []
      const sessions = canonicalSessions(body.sessions)
      const previousAudioKeys = audioKeysInSessions(previousSessions)
      const nextAudioKeys = audioKeysInSessions(sessions)
      const removedAudioKeys = [...previousAudioKeys].filter((key) => !nextAudioKeys.has(key))
      // Save cleanup intent before CAS. A lost CAS keeps the old reference so
      // reconciliation retains it; a successful CAS makes cleanup durable.
      if (removedAudioKeys.length) {
        const pending = await pendingAudioCompensations(user)
        const known = new Set(pending.map((item) => item.id))
        const cleanup = removedAudioKeys.filter((id) => !known.has(id)).map((id) => ({ id, createdAt: new Date().toISOString() }))
        if (cleanup.length) await storage.config.put(user.id, audioCompensationKey, [...pending, ...cleanup])
      }
      const version = body.version + 1
      if (!await storage.config.compareAndSwap(user.id, 'sessions', body.version, { sessions, version })) {
        return send(response, 409, { error: '遠端記錄已有更新；請重新載入後再同步。' })
      }
      await reconcileAudioCompensations(user, sessions).catch(() => undefined)
      return send(response, 200, { saved: true, version })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存紀錄' }) }
  }
  if (storagePath === '/api/data/glossary' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') {
        const stored = typeof storage.config.getGlossary === 'function' ? await storage.config.getGlossary(user.id) : { content: await storage.config.get(user.id, 'glossary') ?? '', version: 0 }
        return send(response, 200, { glossary: stored.content, version: stored.version, updatedAt: stored.updatedAt ?? null })
      }
      const body = JSON.parse((await readBody(request, 256 * 1024)).toString('utf8'))
      if (typeof body.glossary !== 'string') return send(response, 400, { error: 'glossary 必須是文字' })
      const content = body.glossary.trim().slice(0, 20_000)
      const expectedVersion = Number.isSafeInteger(body.version) && body.version >= 0 ? body.version : null
      if (typeof storage.config.putGlossary === 'function' && expectedVersion === null) return send(response, 400, { error: 'version 必須有效' })
      const saved = typeof storage.config.putGlossary === 'function' ? await storage.config.putGlossary(user.id, content, expectedVersion) : (await storage.config.put(user.id, 'glossary', content), { version: 0 })
      if (!saved) return send(response, 409, { error: '術語已被其他視窗更新；請重新載入後再儲存。' })
      return send(response, 200, { saved: true, version: saved.version, updatedAt: saved.updatedAt ?? null })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存術語' }) }
  }
  if (storagePath === '/api/data/settings' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') {
        const stored = await storage.config.get(user.id, 'app-settings')
        return send(response, 200, stored && !Array.isArray(stored.settings) && stored.settings && typeof stored.settings === 'object' && Number.isSafeInteger(stored.version) ? stored : { settings: {}, version: 0 })
      }
      const body = JSON.parse((await readBody(request, 512 * 1024)).toString('utf8'))
      if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings) || !Number.isSafeInteger(body.version) || body.version < 0) return send(response, 400, { error: 'settings 與 version 必須有效' })
      const settings = JSON.parse(JSON.stringify(body.settings))
      if (!await storage.config.compareAndSwap(user.id, 'app-settings', body.version, { settings, version: body.version + 1 })) return send(response, 409, { error: '設定已被其他視窗更新；請重新載入後再儲存。' })
      return send(response, 200, { saved: true, version: body.version + 1 })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存設定' }) }
  }
  if (['/api/data/live-draft', '/api/data/import-checkpoint'].includes(storagePath) && ['GET', 'POST', 'DELETE'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const key = storagePath.endsWith('live-draft') ? 'live-draft' : 'import-checkpoint'
    try {
      if (request.method === 'GET') return send(response, 200, { value: await storage.config.get(user.id, key) })
      if (request.method === 'DELETE') { await storage.config.remove(user.id, key); return send(response, 204, '') }
      const body = JSON.parse((await readBody(request, 2 * 1024 * 1024)).toString('utf8'))
      if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) return send(response, 400, { error: '暫存資料無效' })
      await storage.config.put(user.id, key, JSON.parse(JSON.stringify(body.value)))
      return send(response, 204, '')
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '暫存資料保存失敗' }) }
  }
  if (storagePath === '/api/data/model-registry' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') {
        const stored = await storage.config.get(user.id, 'model-registry')
        return send(response, 200, stored && Array.isArray(stored.models) && Number.isSafeInteger(stored.version) ? stored : { models: [], version: 0 })
      }
      const body = JSON.parse((await readBody(request, 256 * 1024)).toString('utf8'))
      if (!Array.isArray(body.models) || !Number.isSafeInteger(body.version) || body.version < 0) return send(response, 400, { error: 'models 與 version 必須有效' })
      const models = body.models.flatMap((item) => item && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.id) && typeof item.name === 'string' && typeof item.endpoint === 'string' && typeof item.model === 'string' && ['asr', 'translation', 'summary', 'diarization', 'embedding'].includes(item.purpose)
        ? [{ id: item.id, name: item.name.trim().slice(0, 120), endpoint: item.endpoint.trim().slice(0, 2000), model: item.model.trim().slice(0, 200), purpose: item.purpose, requiresApiKey: item.requiresApiKey !== false, capabilities: item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {} }]
        : [])
      if (models.length !== body.models.length || new Set(models.map((item) => item.id)).size !== models.length) return send(response, 400, { error: '模型資料無效或 ID 重複' })
      const value = { models, version: body.version + 1 }
      if (!await storage.config.compareAndSwap(user.id, 'model-registry', body.version, value)) return send(response, 409, { error: '模型清單已被其他視窗更新；請重新載入。' })
      for (const model of models) modelHealthChecks.delete(`${user.id}:${model.id}`)
      return send(response, 200, { saved: true, version: value.version })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存模型清單' }) }
  }
  if (storagePath === '/api/data/model-health' && request.method === 'POST') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      const registry = await storage.config.get(user.id, 'model-registry')
      const models = Array.isArray(registry?.models) ? registry.models : []
      const health = await Promise.all(models.map((model) => modelHealth(auth, user, model)))
      return send(response, 200, { health })
    } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : '模型健康檢查失敗' }) }
  }
  if (storagePath === '/api/audio-processing/status' && request.method === 'GET') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try { return send(response, 200, await audioPreprocessStatus()) }
    catch (error) { return send(response, 503, { sileroVad: { available: false, reason: error instanceof Error ? error.message : 'Silero VAD 狀態無法取得' }, dynaudnorm: { available: false, reason: '音訊前處理 worker 無法取得狀態' } }) }
  }
  if (storagePath === '/api/audio-processing/silero-vad' && request.method === 'POST') {
    const limit = acceptsRequest(request, 'silero-vad')
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many Silero VAD requests. Try again later.')
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (!safeAudioContentType(request.headers['content-type'])) return send(response, 415, { error: 'Silero VAD 僅接受支援的音訊格式' })
      const audio = await readBody(request, maxAsrAudioBytes)
      if (!audio.length) return send(response, 400, { error: '音訊不可為空' })
      return send(response, 200, await analyzeSileroVad(audio))
    } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'Silero VAD 處理失敗' }) }
  }
  if (storagePath === '/api/data/diarization-jobs' && (request.method === 'POST' || request.method === 'GET')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    if (typeof storage.config.enqueueDiarizationJob !== 'function') return send(response, 503, { error: '目前 storage 不支援持久化講者分離工作' })
    try {
      if (request.method === 'GET') {
        const id = new URL(request.url, 'http://localhost').searchParams.get('id') || ''
        if (!id) return send(response, 400, { error: 'job id 必須有效' })
        const job = await storage.config.getDiarizationJob(user.id, id)
        return job ? send(response, 200, { job }) : send(response, 404, { error: '找不到講者分離工作' })
      }
      const body = JSON.parse((await readBody(request, 32 * 1024)).toString('utf8'))
      if (typeof body.sessionId !== 'string' || typeof body.audioKey !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(body.audioKey)) return send(response, 400, { error: 'sessionId 與 audioKey 必須有效' })
      const job = await storage.config.enqueueDiarizationJob({ id: randomUUID(), userId: user.id, sessionId: body.sessionId, audioKey: body.audioKey, payload: { user: { id: user.id, NT: user.NT, Department: user.Department }, modelId: 'managed-diarization' } })
      return send(response, 202, { job })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法建立講者分離工作' }) }
  }
  if (storagePath.startsWith('/api/data/model-credentials/') && (request.method === 'POST' || request.method === 'DELETE')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const id = decodeURIComponent(storagePath.slice('/api/data/model-credentials/'.length))
    if (!validCredentialId(id)) return send(response, 400, { error: '模型 ID 無效' })
    try {
      // One config record per model prevents two tabs updating different keys
      // from racing on a shared credentials object.
      const key = `model-credential-${id}`
      if (request.method === 'DELETE') {
        await storage.config.remove(user.id, key)
        return send(response, 204, '')
      }
      const body = JSON.parse((await readBody(request, 16 * 1024)).toString('utf8'))
      if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 8_000) return send(response, 400, { error: 'API key 無效' })
      await storage.config.put(user.id, key, encryptCredential(auth.secret, body.apiKey.trim()))
      return send(response, 204, '')
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存 API key' }) }
  }
  if (storagePath === '/api/data/summary-templates' && (request.method === 'GET' || request.method === 'POST')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') {
        const stored = await storage.config.get(user.id, 'summary-templates')
        return send(response, 200, stored && Array.isArray(stored.templates) && Number.isSafeInteger(stored.version) ? stored : { templates: [], selectedTemplateId: null, version: 0 })
      }
      const body = JSON.parse((await readBody(request, 256 * 1024)).toString('utf8'))
      if (!Array.isArray(body.templates) || !Number.isSafeInteger(body.version) || body.version < 0) return send(response, 400, { error: 'templates 與 version 必須有效' })
      const templates = body.templates.flatMap((template) => typeof template?.id === 'string' && typeof template.name === 'string' && typeof template.content === 'string' && template.id.trim() && template.name.trim() && template.content.trim()
        ? [{ id: template.id.trim().slice(0, 100), name: template.name.trim().slice(0, 100), content: template.content.slice(0, 20_000) }] : [])
      if (!templates.length || templates.length > 100) return send(response, 400, { error: '至少需保留一個有效模板，且最多 100 個' })
      const selectedTemplateId = templates.some((template) => template.id === body.selectedTemplateId) ? body.selectedTemplateId : templates[0].id
      const value = { templates, selectedTemplateId, version: body.version + 1 }
      if (!await storage.config.compareAndSwap(user.id, 'summary-templates', body.version, value)) return send(response, 409, { error: '摘要模板已被其他視窗更新；請重新載入後再儲存。' })
      return send(response, 200, { saved: true, version: value.version })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法保存摘要模板' }) }
  }
  const audioMatch = storagePath.match(/^\/api\/data\/audio\/([A-Za-z0-9._-]{1,160})$/)
  if (audioMatch && ['GET', 'POST', 'DELETE'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const audioKey = `audio/${audioMatch[1]}`
    try {
      if (request.method === 'POST') {
        const audio = await readBody(request, 1024 * 1024 * 1024); if (!audio.length) return send(response, 400, { error: '音檔不可為空' })
        const pending = await pendingAudioCompensations(user)
        if (!pending.some((item) => item.id === audioMatch[1])) await storage.config.put(user.id, audioCompensationKey, [...pending, { id: audioMatch[1], createdAt: new Date().toISOString() }])
        try { await storage.blob.put(user.id, audioKey, audio) } catch (error) { await storage.config.put(user.id, audioCompensationKey, (await pendingAudioCompensations(user)).filter((item) => item.id !== audioMatch[1])).catch(() => undefined); throw error }
        return send(response, 201, { saved: true, pendingSessionCommit: true })
      }
      if (request.method === 'DELETE') { await storage.blob.remove(user.id, audioKey); await storage.config.put(user.id, audioCompensationKey, (await pendingAudioCompensations(user)).filter((item) => item.id !== audioMatch[1])); return send(response, 204, '') }
      const audio = await storage.blob.get(user.id, audioKey); return audio ? send(response, 200, audio, 'audio/wav') : send(response, 404, { error: '找不到音檔' })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '音檔操作失敗' }) }
  }
  if (storagePath === '/api/voiceprints' && ['GET', 'POST'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      await reconcileVoiceprintCompensations(user)
      if (request.method === 'GET') return send(response, 200, { voiceprints: await ownVoiceprints(user) })
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: '聲紋註冊需要 WAV 音檔' })
      const sharingScope = String(request.headers['x-s2t-voiceprint-sharing'] || 'private')
      if (!['private', 'department', 'organization'].includes(sharingScope)) return send(response, 400, { error: '無效的聲紋共享範圍' })
      if (sharingScope !== 'private' && request.headers['x-s2t-voiceprint-consent'] !== 'true') return send(response, 400, { error: '分享聲紋前必須明確同意比對用途' })
      const quality = await assessVoiceprintSample(audio)
      const embedding = await extractSpeakerEmbedding(audio)
      const id = `vp-${randomUUID()}`
      const metadata = voiceprintEmbeddingMetadata()
      let vectorSaved = false; let metadataSaved = false
      await saveVoiceprintCompensations(user, [...await pendingVoiceprintCompensations(user), { id, type: 'enroll-cleanup', createdAt: new Date().toISOString() }])
      try {
        await storage.vector.upsert({ id, NT: user.NT, Department: user.Department, embedding }); vectorSaved = true
        if (typeof storage.config.createVoiceprint === 'function') { await storage.config.createVoiceprint({ vectorId: id, userId: user.id, embeddingModel: metadata.model, embeddingVersion: metadata.version, sharingScope }); metadataSaved = true }
        const existing = await ownVoiceprints(user)
        const entry = { id, createdAt: new Date().toISOString(), NT: user.NT, Department: user.Department, dimensions: embedding.length, embeddingModel: metadata.model, embeddingVersion: metadata.version, sharingScope, sampleDurationMs: quality.durationMs, sampleRmsDbfs: quality.rmsDbfs }
        await storage.config.put(user.id, voiceprintRecordKey, [...existing, entry])
        await saveVoiceprintCompensations(user, (await pendingVoiceprintCompensations(user)).filter((item) => item.id !== id))
      } catch (error) {
        if (metadataSaved) await storage.config.removeVoiceprint(id, user.id).catch(() => undefined)
        if (vectorSaved) await storage.vector.remove(id).catch(() => undefined)
        throw error
      }
      const entry = (await ownVoiceprints(user)).find((item) => item.id === id)
      return send(response, 201, { voiceprint: entry })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '聲紋註冊失敗' }) }
  }
  const voiceprintMatch = storagePath.match(/^\/api\/voiceprints\/([A-Za-z0-9._-]{1,160})$/)
  if (voiceprintMatch && request.method === 'DELETE') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      await reconcileVoiceprintCompensations(user)
      const voiceprints = await ownVoiceprints(user)
      if (!voiceprints.some((item) => item.id === voiceprintMatch[1])) return send(response, 404, { error: '找不到此聲紋註冊資料' })
      await saveVoiceprintCompensations(user, [...await pendingVoiceprintCompensations(user), { id: voiceprintMatch[1], type: 'delete', createdAt: new Date().toISOString() }])
      await storage.vector.remove(voiceprintMatch[1])
      if (typeof storage.config.removeVoiceprint === 'function' && !await storage.config.removeVoiceprint(voiceprintMatch[1], user.id)) throw new Error('聲紋 metadata 刪除失敗，已排程重試')
      await storage.config.put(user.id, voiceprintRecordKey, voiceprints.filter((item) => item.id !== voiceprintMatch[1]))
      await saveVoiceprintCompensations(user, (await pendingVoiceprintCompensations(user)).filter((item) => item.id !== voiceprintMatch[1]))
      return send(response, 204, '')
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法刪除聲紋' }) }
  }
  if (storagePath === '/api/voiceprints/identify' && request.method === 'POST') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: '聲紋比對需要 WAV 音檔' })
      const matches = await findIdentityCandidates(storage.vector, await extractSpeakerEmbedding(audio), await visibleVoiceprintIds(user))
      const candidate = matches[0]
      const runnerUp = matches[1]
      return send(response, 200, { threshold: voiceprintThreshold, margin: voiceprintMargin, match: candidate && candidate.score >= voiceprintThreshold && (!runnerUp || candidate.score - runnerUp.score >= voiceprintMargin) ? candidate : null })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '聲紋比對失敗' }) }
  }
  if (request.method === 'POST' && request.url === '/api/transcriptions') {
    const limit = acceptsRequest(request, 'transcriptions')
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many transcription requests. Try again later.')
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const profileId = String(request.headers['x-s2t-model-id'] || 'default')
    const environmentAsr = asrProfileById.get(profileId)
    const selectedAsr = environmentAsr || await accountModelService(auth, user, profileId, 'asr')
    if (!selectedAsr) return send(response, 400, { error: 'The requested ASR model is not registered on this gateway.' })
    if (!selectedAsr.endpoint || !selectedAsr.model || (environmentAsr && !selectedAsr.apiKey)) return send(response, 503, { error: 'Web ASR gateway has not been configured.' })
    try {
      const contentType = safeAudioContentType(request.headers['content-type'])
      if (!contentType) return send(response, 415, { error: 'Unsupported audio content type. Use WAV, MP3, M4A/AAC, OGG, WebM, FLAC, MP4, or MOV.' })
      const requestedLanguage = String(request.headers['x-s2t-language'] || '')
      if (requestedLanguage && !['zh', 'en', 'ja', 'de'].includes(requestedLanguage)) return send(response, 400, { error: 'Unsupported ASR language. Use zh, en, ja, de, or omit it for automatic detection.' })
      let audio = await readBody(request, maxAsrAudioBytes)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      if (request.headers['x-s2t-dynaudnorm'] === 'true') audio = await dynaudnormWav(audio)
      const client = new OpenAI({ apiKey: selectedAsr.apiKey, baseURL: baseUrl(selectedAsr.endpoint), timeout: 20_000, maxRetries: 1 })
      const result = await client.audio.transcriptions.create({
        file: await toFile(audio, safeUploadFilename(request.headers['x-s2t-filename']), { type: contentType }), model: selectedAsr.model,
        ...(requestedLanguage ? { language: requestedLanguage } : {}),
        ...(request.headers['x-s2t-prompt'] ? { prompt: String(request.headers['x-s2t-prompt']).slice(0, 10_000) } : {})
      })
      return send(response, 200, { text: result.text || '', detectedLanguage: normalizeDetectedLanguage(result.language) })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'ASR request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/translations') {
    const limit = acceptsRequest(request, 'translations')
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many translation requests. Try again later.')
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const profileId = String(request.headers['x-s2t-model-id'] || '')
    const selectedTranslation = profileId ? await accountModelService(auth, user, profileId, 'translation') : translation
    if (!selectedTranslation?.endpoint || !selectedTranslation.model || (!profileId && !selectedTranslation.apiKey)) return send(response, 503, { error: 'Web translation gateway has not been configured.' })
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
      const textResult = await completeText(selectedTranslation, [{ role: 'user', content: hyTranslationPrompt(text, sourceLanguage, targetLanguage, glossary) }])
      return send(response, 200, { text: textResult })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Translation request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/summaries') {
    const limit = acceptsRequest(request, 'summaries')
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many summary requests. Try again later.')
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const profileId = String(request.headers['x-s2t-model-id'] || '')
    const selectedSummary = profileId ? await accountModelService(auth, user, profileId, 'summary') : summary
    if (!selectedSummary?.endpoint || !selectedSummary.model || (!profileId && !selectedSummary.apiKey)) return send(response, 503, { error: 'Web summary gateway has not been configured.' })
    try {
      const input = JSON.parse((await readBody(request, 256 * 1024)).toString('utf8'))
      const messages = Array.isArray(input.messages) ? input.messages.filter((item) => item && (item.role === 'system' || item.role === 'user') && typeof item.content === 'string').slice(0, 8) : []
      if (!messages.length) return send(response, 400, { error: 'Messages are required.' })
      return send(response, 200, { text: await completeText(selectedSummary, messages) })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Summary request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/diarizations') {
    const limit = acceptsRequest(request, 'diarizations')
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many diarization requests. Try again later.')
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      const profileId = String(request.headers['x-s2t-model-id'] || '')
      const selectedDiarization = profileId ? await accountModelService(auth, user, profileId, 'diarization') : diarization
      if (profileId && !selectedDiarization) return send(response, 400, { error: 'The requested diarization model is not registered on this gateway.' })
      if (selectedDiarization?.endpoint && selectedDiarization.model) {
        if (!profileId && !selectedDiarization.apiKey) return send(response, 503, { error: 'Web diarization gateway has not been configured.' })
        const headers = selectedDiarization.apiKey ? { authorization: `Bearer ${selectedDiarization.apiKey}` } : {}
        const form = new FormData()
        form.set('model', selectedDiarization.model)
        form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
        const remote = await fetch(selectedDiarization.endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(120_000) })
        const body = await remote.text()
        if (!remote.ok) return send(response, remote.status, { error: body || `HTTP ${remote.status}` })
        let payload
        try { payload = JSON.parse(body) } catch { return send(response, 502, { error: '講者分離服務回傳的格式不是 JSON' }) }
        const turns = diarizationTurns(payload)
        if (!turns.length) return send(response, 200, payload)
        const labeledTurns = await labelDiarizationTurns(user, audio, turns)
        return send(response, 200, { ...payload, exclusive_diarization: labeledTurns })
      }
      const segments = await diarizeWav(audio)
      const labeledSegments = await labelDiarizationTurns(user, audio, segments)
      return send(response, 200, { model: 'sherpa-onnx-speaker-diarization', threshold: voiceprintThreshold, exclusive_diarization: labeledSegments })
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Speaker diarization failed' })
    }
  }
  return staticFile(request, response)
}).listen(port, () => console.log(`S2T web gateway: http://0.0.0.0:${port}`))

if (processRole === 'audio-worker') console.log(`S2T audio worker started; health probes on http://0.0.0.0:${port}; durable diarization jobs are enabled.`)

const stopServer = () => {
  acceptingDiarizationJobs = false
  httpServer?.close(() => undefined)
  // A rolling update should normally let the active durable job finish. If
  // Kubernetes force-terminates this process, its lease expires and another
  // Pod claims it; the generation fence prevents this Pod's stale result from
  // being committed after that handoff.
  const graceMs = Math.max(1_000, Number(process.env.S2T_SHUTDOWN_GRACE_MS || 25_000))
  const finish = activeDiarizationJob ? Promise.race([activeDiarizationJob, new Promise((resolve) => setTimeout(resolve, graceMs))]) : Promise.resolve()
  void finish.finally(() => sherpaWorkerPool.close()).finally(() => process.exit(0))
}
process.once('SIGTERM', stopServer)
process.once('SIGINT', stopServer)
