const { createServer } = require('node:http')
const { readFile, stat } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { join, normalize, basename } = require('node:path')
const { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto')
const OpenAI = require('openai').default
const { toFile } = require('openai')
const { config } = require('dotenv')
const { diarizeWav, extractSpeakerEmbedding, extractDiarizedSpeakerBlocks, assessVoiceprintSample, modelPaths, sherpaWorkerPool, analyzeSileroVad, audioPreprocessStatus, dynaudnormWav } = require('./sherpa-worker-pool.cjs')
const { modelStatus: sileroModelStatus } = require('./silero-vad.cjs')
const { findIdentityCandidates, findMatches, identityCandidates, identityKey, decideIdentity, fastMatch } = require('./voiceprint-matching.cjs')
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
const requestLimits = { transcriptions: 60, translations: 30, summaries: 12, diarizations: 8, audioUploads: 30, voiceprintUploads: 12 }
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
  for (const [poolName, value] of Object.entries(worker.pools)) {
    for (const state of ['configured', 'workers', 'busy', 'queued', 'inFlight', 'maxQueue']) {
      lines.push(`s2t_sherpa_worker_jobs{pool="${poolName}",state="${state}"} ${value[state]}`)
    }
  }
  lines.push(
    '# HELP s2t_sherpa_op_duration_seconds_total CPU time per sherpa operation.',
    '# TYPE s2t_sherpa_op_duration_seconds_total counter',
    '# HELP s2t_sherpa_op_audio_seconds_total Audio seconds processed per operation.',
    '# TYPE s2t_sherpa_op_audio_seconds_total counter',
    '# HELP s2t_sherpa_op_audio_bytes_total Audio bytes owned per operation.',
    '# TYPE s2t_sherpa_op_audio_bytes_total counter',
    '# HELP s2t_sherpa_op_transferred_bytes_total Audio bytes copied across the worker boundary.',
    '# TYPE s2t_sherpa_op_transferred_bytes_total counter',
    '# HELP s2t_sherpa_op_rtf Real-time factor of executed work.',
    '# TYPE s2t_sherpa_op_rtf gauge'
  )
  for (const [operation, value] of Object.entries(worker.ops)) {
    const op = operation.replace(/[^A-Za-z0-9_]/g, '_')
    lines.push(`s2t_sherpa_op_duration_seconds_total{op="${op}"} ${(value.totalMs / 1_000).toFixed(3)}`)
    lines.push(`s2t_sherpa_op_audio_seconds_total{op="${op}"} ${value.audioSec}`)
    lines.push(`s2t_sherpa_op_audio_bytes_total{op="${op}"} ${value.audioBytes}`)
    lines.push(`s2t_sherpa_op_transferred_bytes_total{op="${op}"} ${value.transferredBytes}`)
    lines.push(`s2t_sherpa_op_rtf{op="${op}"} ${value.rtf ?? 0}`)
  }
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
// OpenAI-compatible services are probed through GET /models (the standard
// healthy check). Local sherpa-onnx and Silero services expose no such
// endpoint, so they get dedicated validations below.
const isLocalEndpoint = (endpoint) => typeof endpoint === 'string' && (endpoint.startsWith('/api/') || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(endpoint))
const modelProbeKind = (model) => {
  const haystack = `${model.name || ''} ${model.model || ''} ${model.endpoint || ''}`.toLowerCase()
  if (haystack.includes('silero')) return 'silero'
  if (haystack.includes('sherpa')) return 'sherpa'
  if (isLocalEndpoint(model.endpoint)) return 'sherpa'
  return 'openai'
}
// Custom validation for sherpa-onnx: packaged model files must exist, the
// native runtime must load, and the CPU worker must answer a lightweight ping.
const sherpaHealth = async (model) => {
  const checkedAt = Date.now()
  try {
    const paths = modelPaths()
    const required = model.purpose === 'diarization'
      ? [['講者分離 segmentation 模型', paths.segmentation], ['聲紋 embedding 模型', paths.embedding]]
      : model.purpose === 'embedding' ? [['聲紋 embedding 模型', paths.embedding]] : []
    const missing = required.filter(([, file]) => !existsSync(file))
    if (missing.length) return { id: model.id, state: 'unhealthy', reason: `找不到 sherpa-onnx 模型檔：${missing.map(([label]) => label).join('、')}`, checkedAt }
    try { require('sherpa-onnx-node') } catch (error) { return { id: model.id, state: 'unhealthy', reason: `sherpa-onnx runtime 無法載入：${error instanceof Error ? error.message.slice(0, 120) : '未知錯誤'}`, checkedAt } }
    try {
      await audioPreprocessStatus()
      return { id: model.id, state: 'healthy', reason: required.length ? 'sherpa-onnx 模型檔、runtime 與 worker 均就緒' : 'sherpa-onnx runtime 與 worker 均就緒', checkedAt }
    } catch (error) {
      return { id: model.id, state: 'degraded', reason: `模型已就緒，但本機 worker 暫無回應：${error instanceof Error ? error.message.slice(0, 120) : '逾時'}`, checkedAt }
    }
  } catch (error) { return { id: model.id, state: 'unhealthy', reason: error instanceof Error ? error.message.slice(0, 160) : 'sherpa-onnx 驗證失敗', checkedAt } }
}
// Custom validation for Silero VAD: model file, sha256 checksum and the ONNX
// runtime must all be present before the worker will accept audio.
const sileroHealth = (model) => {
  const checkedAt = Date.now()
  try {
    const status = sileroModelStatus()
    return status.available
      ? { id: model.id, state: 'healthy', reason: `Silero VAD 模型與 checksum 驗證通過（${status.path}）`, checkedAt }
      : { id: model.id, state: 'unhealthy', reason: status.reason || 'Silero VAD 模型不可用', checkedAt }
  } catch (error) { return { id: model.id, state: 'unhealthy', reason: error instanceof Error ? error.message.slice(0, 160) : 'Silero VAD 驗證失敗', checkedAt } }
}
const openaiHealth = async (model, service) => {
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
}
const modelHealth = async (auth, user, model) => {
  const key = `${user.id}:${model.id}`
  const cached = modelHealthChecks.get(key)
  const now = Date.now()
  if (cached?.value && now - cached.value.checkedAt < 60_000) return cached.value
  if (cached?.pending) return cached.pending
  const pending = (async () => {
    const kind = modelProbeKind(model)
    if (kind === 'silero') return sileroHealth(model)
    if (kind === 'sherpa') return sherpaHealth(model)
    const service = model.service || await accountModelService(auth, user, model.id, model.purpose)
    return openaiHealth(model, service)
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
// Uploads and voiceprint enrolments perform their durable write first and are
// committed by a *later* request (session save / index write). Until that
// commit lands the cleanup intent recorded ahead of the write must not be
// treated as an abandoned one, or a concurrent reconcile (another tab, an
// in-flight session save, storage-retry) deletes bytes the client already
// believes are safe. Grace is measured from intent creation; deployments or
// tests that reconcile immediately can shorten it, 0 disables the protection.
const configuredCompensationGrace = process.env.S2T_STORAGE_COMPENSATION_GRACE_MS
const compensationGraceMs = (() => {
  const value = configuredCompensationGrace === undefined || String(configuredCompensationGrace).trim() === '' ? NaN : Number(configuredCompensationGrace)
  return Number.isFinite(value) && value >= 0 ? value : 30_000
})()
const compensationEligible = (item) => typeof item?.eligibleAfter !== 'number' || Date.now() >= item.eligibleAfter
const asList = (value) => (Array.isArray(value) ? value : [])
// Every shared list (compensation queues and the voiceprints index) is updated
// through the config store's atomic read-modify-write so concurrent requests
// cannot drop each other's entries; transforms return undefined to skip the
// write when nothing changed.
const updateAudioCompensations = (user, transform) => storage.config.update(user.id, audioCompensationKey, (value) => transform(asList(value)))
const updateVoiceprintCompensations = (user, transform) => storage.config.update(user.id, voiceprintCompensationKey, (value) => transform(asList(value)))
const updateVoiceprintIndex = (user, transform) => storage.config.update(user.id, voiceprintRecordKey, (value) => transform(asList(value)))
const addAudioCompensation = (user, item) => updateAudioCompensations(user, (entries) => (entries.some((entry) => entry.id === item.id) ? undefined : [...entries, item]))
const dropAudioCompensation = (user, id) => updateAudioCompensations(user, (entries) => (entries.some((entry) => entry.id === id) ? entries.filter((entry) => entry.id !== id) : undefined))
const addVoiceprintCompensation = (user, item) => updateVoiceprintCompensations(user, (entries) => (entries.some((entry) => entry.id === item.id) ? undefined : [...entries, item]))
const dropVoiceprintCompensation = (user, id) => updateVoiceprintCompensations(user, (entries) => (entries.some((entry) => entry.id === id) ? entries.filter((entry) => entry.id !== id) : undefined))
const voiceprintThreshold = Math.max(0, Math.min(1, Number(process.env.S2T_VOICEPRINT_THRESHOLD || 0.65)))
// A high best score alone is insufficient when two enrolled voices are close.
// Keep ambiguous turns anonymous instead of confidently assigning the wrong NT.
const voiceprintMargin = Math.max(0, Math.min(1, Number(process.env.S2T_VOICEPRINT_MARGIN || 0.05)))
const voiceprintEnvNumber = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value >= 0 ? value : fallback }
const voiceprintEnvInteger = (name, fallback) => { const value = Number.parseInt(process.env[name] || '', 10); return Number.isInteger(value) && value > 0 ? value : fallback }
// A single unambiguous leading block needs no further evidence; everything
// else must be confirmed by independent blocks of the same speaker.
const voiceprintFastScore = voiceprintEnvNumber('S2T_VOICEPRINT_FAST_SCORE', 0.75)
const voiceprintFastMargin = voiceprintEnvNumber('S2T_VOICEPRINT_FAST_MARGIN', 0.15)
// How many independent blocks must clear the threshold before a turn is
// labelled. Below this the turn stays anonymous instead of guessing.
const voiceprintMinBlocks = voiceprintEnvInteger('S2T_VOICEPRINT_MIN_BLOCKS', 2)
const voiceprintCandidateLimit = voiceprintEnvInteger('S2T_VOICEPRINT_CANDIDATE_BLOCKS', 3)
const voiceprintLogEnabled = process.env.S2T_VOICEPRINT_LOG !== '0'
const voiceprintLog = (event) => { if (voiceprintLogEnabled) console.log(`[voiceprint] ${JSON.stringify(event)}`) }
const voiceprintDecisionOptions = {
  threshold: voiceprintThreshold,
  margin: voiceprintMargin,
  minBlocks: voiceprintMinBlocks,
  fastScore: voiceprintFastScore,
  fastMargin: voiceprintFastMargin
}
const voiceprintEmbeddingMetadata = () => ({ model: process.env.S2T_VOICEPRINT_EMBEDDING_MODEL_NAME || basename(modelPaths().embedding), version: process.env.S2T_VOICEPRINT_EMBEDDING_VERSION || 'sherpa-onnx-v1' })
const ownVoiceprints = async (user) => {
  const value = await storage.config.get(user.id, voiceprintRecordKey)
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && typeof item.createdAt === 'string') : []
}
const pendingVoiceprintCompensations = async (user) => {
  const value = await storage.config.get(user.id, voiceprintCompensationKey)
  return Array.isArray(value) ? value.filter((item) => item && typeof item.id === 'string' && (item.type === 'enroll-cleanup' || item.type === 'delete')) : []
}
const reconcileVoiceprintCompensations = async (user) => {
  const pending = await pendingVoiceprintCompensations(user)
  if (!pending.length) return
  const processed = []
  for (const item of pending) {
    // A very recent intent may still belong to an in-flight enrolment; keep it
    // queued until the grace window passes instead of racing that request.
    if (!compensationEligible(item)) continue
    try {
      await storage.vector.remove(item.id)
      if (typeof storage.config.removeVoiceprint === 'function') await storage.config.removeVoiceprint(item.id, user.id)
      await updateVoiceprintIndex(user, (entries) => {
        const next = entries.filter((entry) => entry?.id !== item.id)
        return next.length === entries.length ? undefined : next
      })
      processed.push(item.id)
    } catch { /* still failing: the intent stays queued for the next retry */ }
  }
  // Drop only what this pass finished. Writing the whole retained list would
  // erase an intent another request queued while this pass was running.
  if (processed.length) await updateVoiceprintCompensations(user, (entries) => entries.filter((entry) => !processed.includes(entry.id)))
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
  const processed = []
  for (const item of pending) {
    // Referenced blobs are committed: drop their cleanup intent.
    if (referenced.has(item.id)) { processed.push(item.id); continue }
    // A freshly uploaded blob may be moments away from its session commit.
    // Deleting it here would leave the imminent commit pointing at nothing.
    if (!compensationEligible(item)) continue
    try { await storage.blob.remove(user.id, `audio/${item.id}`); processed.push(item.id) } catch { /* still failing: keep the intent queued */ }
  }
  // Remove only what this pass finished so intents queued concurrently survive.
  if (processed.length) await updateAudioCompensations(user, (entries) => entries.filter((entry) => !processed.includes(entry.id)))
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
  const startedAt = Date.now()
  const recognized = new Map()
  const allowedVoiceprintIds = await visibleVoiceprintIds(user)
  // No enrolled voiceprint is visible: skip embedding inference entirely.
  if (!allowedVoiceprintIds.length || !turns.length) return turns
  // One bounded worker job: each speaker contributes a few short blocks
  // instead of one embedding built from the whole meeting.
  const speakerBlocks = await extractDiarizedSpeakerBlocks(audio, turns)
  const extractionMs = Date.now() - startedAt
  let cursor = Date.now()
  let accepted = 0
  const flatten = (detail = {}) => ({ top1: detail.top1?.NT ?? null, top1Score: detail.top1?.score ?? null, top2: detail.top2?.NT ?? null, top2Score: detail.top2?.score ?? null, margin: detail.margin ?? null, hits: detail.hits ?? null, evaluated: detail.evaluated ?? null })
  for (const item of speakerBlocks) {
    const report = { speaker: item.speaker, speechMs: item.speechMs, blocks: item.blocks.length }
    const elapsed = () => { const ms = Date.now() - cursor; cursor = Date.now(); return ms }
    if (!item.blocks.length) { voiceprintLog({ ...report, decision: 'reject', reason: item.vetoed ? 'recording-no-speech' : 'no-usable-block', ms: elapsed() }); continue }
    // Stage 1: only the first block searches the whole authorized library.
    const matches = await findMatches(storage.vector, item.blocks[0].embedding, allowedVoiceprintIds)
    const candidates = identityCandidates(matches)
    if (!candidates.length) { voiceprintLog({ ...report, decision: 'reject', reason: 'no-candidate', ms: elapsed() }); continue }
    const leading = candidates.slice(0, voiceprintCandidateLimit)
    const blockScores = leading.map((candidate) => [candidate.score])
    // An unambiguous first block never pays for the remaining blocks.
    if (!fastMatch(leading, { fastScore: voiceprintFastScore, fastMargin: voiceprintFastMargin })) {
      const leadingKeys = new Set(leading.map(identityKey))
      const leadingIds = matches.filter((match) => leadingKeys.has(identityKey(match))).map((match) => match.id)
      for (const block of item.blocks.slice(1)) {
        // Stage 2 verifies the remaining blocks only against the identities
        // stage 1 already surfaced.
        const pool = leadingIds.length ? leadingIds : allowedVoiceprintIds
        const verified = new Map(identityCandidates(await findMatches(storage.vector, block.embedding, pool)).map((candidate) => [identityKey(candidate), candidate.score]))
        leading.forEach((candidate, index) => blockScores[index].push(verified.has(identityKey(candidate)) ? verified.get(identityKey(candidate)) : 0))
      }
    }
    const decision = decideIdentity({ candidates: leading, blockScores, ...voiceprintDecisionOptions })
    if (decision.accepted) {
      recognized.set(item.speaker, decision.candidate)
      accepted += 1
      voiceprintLog({ ...report, decision: 'accept', path: decision.path, ...flatten(decision.detail), ms: elapsed() })
      continue
    }
    // Rejecting keeps the turn anonymous; a wrong NT is far more expensive.
    voiceprintLog({ ...report, decision: 'reject', reason: decision.reason, ...flatten(decision.detail), ms: elapsed() })
  }
  voiceprintLog({ summary: true, speakers: speakerBlocks.length, accepted, rejected: speakerBlocks.length - accepted, extractionMs, totalMs: Date.now() - startedAt })
  return turns.map((turn) => {
    const match = recognized.get(turn.speaker)
    return match ? { ...turn, speaker: match.NT, Department: match.Department, matchScore: match.score } : turn
  })
}
// A durable job that can never succeed must not re-run paid inference forever.
// Attempts are counted per claim; once exhausted the job is marked failed and
// stays visible through GET /api/data/diarization-jobs.
const diarizationJobMaxAttempts = (() => {
  const value = Number.parseInt(process.env.S2T_DIARIZATION_JOB_MAX_ATTEMPTS || '', 10)
  return Number.isInteger(value) && value > 0 ? value : 10
})()
const runDurableDiarizationJob = async (auth, owner) => {
  if (typeof storage.config.claimDiarizationJob !== 'function') return
  const job = await storage.config.claimDiarizationJob(owner)
  if (!job) return
  if (job.attempts > diarizationJobMaxAttempts) {
    await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration, `超過最大重試次數（${diarizationJobMaxAttempts}）`).catch(() => undefined)
    return
  }
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
  // authReady rejects when storage/auth cannot initialise (for example a
  // failed schema migration). Answer 503 instead of letting that rejection
  // escape the request listener: an unhandled rejection would crash the whole
  // gateway on its first API request.
  let auth
  try { auth = await authReady } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'storage 尚未就緒，無法處理請求' }) }
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
    // compensationGraceMs lets integration tests wait out the in-flight
    // protection window instead of guessing the gateway's configuration.
    try { await storage.ready; return send(response, 200, { mode: storage.mode, schemaVersion: storage.schemaVersion, ready: true, compensationGraceMs }) }
    catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'Storage is unavailable', mode: storage.mode, schemaVersion: storage.schemaVersion, ready: false, compensationGraceMs }) }
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
        const removed = new Set(removedAudioKeys)
        await updateAudioCompensations(user, (entries) => {
          const known = new Set(entries.map((item) => item.id))
          const cleanup = [...removed].filter((id) => !known.has(id)).map((id) => ({ id, createdAt: new Date().toISOString() }))
          return cleanup.length ? [...entries, ...cleanup] : undefined
        })
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
      const checks = Array.isArray(registry?.models) ? [...registry.models] : []
      // Environment-provided services share the card ids the Web client renders,
      // so their badges refresh on the same automatic schedule.
      const add = (check) => { if (check.endpoint && check.model && !checks.some((item) => item.id === check.id)) checks.push(check) }
      for (const profile of configuredAsrProfiles) add({ id: profile.id === 'default' ? 'web-environment-asr' : `web-gateway-asr-${profile.id}`, name: profile.name, endpoint: profile.endpoint, model: profile.model, purpose: 'asr', service: { endpoint: profile.endpoint, model: profile.model, apiKey: profile.apiKey } })
      add({ id: 'web-environment-translation', name: translation.model, endpoint: translation.endpoint, model: translation.model, purpose: 'translation', service: { endpoint: translation.endpoint, model: translation.model, apiKey: translation.apiKey } })
      add({ id: 'managed-summary', name: summary.model, endpoint: summary.endpoint, model: summary.model, purpose: 'summary', service: { endpoint: summary.endpoint, model: summary.model, apiKey: summary.apiKey } })
      add({ id: 'managed-diarization', name: diarization.model, endpoint: diarization.endpoint, model: diarization.model, purpose: 'diarization', service: { endpoint: diarization.endpoint, model: diarization.model, apiKey: diarization.apiKey } })
      const health = await Promise.all(checks.map((model) => modelHealth(auth, user, model)))
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
      // Frame probabilities are 1 object per 32 ms; ship them only when asked.
      const includeProbabilities = new URL(request.url, 'http://localhost').searchParams.get('frames') === '1'
      return send(response, 200, await analyzeSileroVad(audio, { includeProbabilities }))
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
        // Bodies are buffered in memory up to 1 GiB; bound how fast one client
        // can ask for more of them.
        const limit = acceptsRequest(request, 'audioUploads')
        if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many audio uploads. Try again later.')
        const audio = await readBody(request, 1024 * 1024 * 1024); if (!audio.length) return send(response, 400, { error: '音檔不可為空' })
        // The intent protects this upload until its session commit, and until
        // the grace window passes it must survive concurrent reconciliation.
        await addAudioCompensation(user, { id: audioMatch[1], createdAt: new Date().toISOString(), eligibleAfter: Date.now() + compensationGraceMs })
        try { await storage.blob.put(user.id, audioKey, audio) } catch (error) { await dropAudioCompensation(user, audioMatch[1]).catch(() => undefined); throw error }
        return send(response, 201, { saved: true, pendingSessionCommit: true })
      }
      if (request.method === 'DELETE') { await storage.blob.remove(user.id, audioKey); await dropAudioCompensation(user, audioMatch[1]); return send(response, 204, '') }
      const audio = await storage.blob.get(user.id, audioKey); return audio ? send(response, 200, audio, 'audio/wav') : send(response, 404, { error: '找不到音檔' })
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '音檔操作失敗' }) }
  }
  if (storagePath === '/api/voiceprints' && ['GET', 'POST'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      await reconcileVoiceprintCompensations(user)
      if (request.method === 'GET') return send(response, 200, { voiceprints: await ownVoiceprints(user) })
      // Enrolment bodies are buffered up to 500 MB; bound how fast one client
      // can ask for more of them.
      const limit = acceptsRequest(request, 'voiceprintUploads')
      if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many voiceprint requests. Try again later.')
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
      // The intent covers the writes below; grace keeps a concurrent reconcile
      // from treating it as an abandoned enrolment while this request runs.
      await addVoiceprintCompensation(user, { id, type: 'enroll-cleanup', createdAt: new Date().toISOString(), eligibleAfter: Date.now() + compensationGraceMs })
      try {
        await storage.vector.upsert({ id, NT: user.NT, Department: user.Department, embedding }); vectorSaved = true
        if (typeof storage.config.createVoiceprint === 'function') { await storage.config.createVoiceprint({ vectorId: id, userId: user.id, embeddingModel: metadata.model, embeddingVersion: metadata.version, sharingScope }); metadataSaved = true }
        const entry = { id, createdAt: new Date().toISOString(), NT: user.NT, Department: user.Department, dimensions: embedding.length, embeddingModel: metadata.model, embeddingVersion: metadata.version, sharingScope, sampleDurationMs: quality.durationMs, sampleRmsDbfs: quality.rmsDbfs }
        await updateVoiceprintIndex(user, (entries) => [...entries, entry])
        await dropVoiceprintCompensation(user, id)
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
      // Deleting is idempotent and reconciliation performs exactly the same
      // steps, so this intent needs no grace: a retry may run immediately.
      await addVoiceprintCompensation(user, { id: voiceprintMatch[1], type: 'delete', createdAt: new Date().toISOString() })
      await storage.vector.remove(voiceprintMatch[1])
      if (typeof storage.config.removeVoiceprint === 'function' && !await storage.config.removeVoiceprint(voiceprintMatch[1], user.id)) throw new Error('聲紋 metadata 刪除失敗，已排程重試')
      await updateVoiceprintIndex(user, (entries) => {
        const next = entries.filter((item) => item.id !== voiceprintMatch[1])
        return next.length === entries.length ? undefined : next
      })
      await dropVoiceprintCompensation(user, voiceprintMatch[1])
      return send(response, 204, '')
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : '無法刪除聲紋' }) }
  }
  if (storagePath === '/api/voiceprints/identify' && request.method === 'POST') {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      const limit = acceptsRequest(request, 'voiceprintUploads')
      if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many voiceprint requests. Try again later.')
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
