const { readSessionPayload, createSessionWriteGate } = require('./session-payload.cjs')
const withSessionWrite = createSessionWriteGate()
const { matchesJob, finalizeDiarizationSession } = require('./diarization-session.cjs')
const { createServer } = require('node:http')
const { readFile, stat } = require('node:fs/promises')
const { createReadStream, existsSync, readFileSync } = require('node:fs')
const { join, normalize, basename } = require('node:path')
const { config } = require('dotenv')
// Load .env before modules construct worker pools or capture startup settings.
// Existing process environment still wins (dotenv's default override=false).
config({ path: join(process.cwd(), '.env') })
const { pipeline } = require('node:stream/promises')
const { Transform } = require('node:stream')
const { convertImportAudio, MAX_IMPORT_BYTES } = require('./import-audio.cjs')
const { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto')
const OpenAI = require('openai').default
const { toFile } = require('openai')
const { createAudioClient, handleAudioService, proxyImport } = require('./audio-service.cjs')
const { diarizeWav, extractSpeakerEmbedding, extractSpeakerLabelEmbeddings, extractDiarizedSpeakerBlocks, assessVoiceprintSample, modelPaths, sherpaWorkerPool, analyzeSileroVad, audioPreprocessStatus, warmSileroVad, dynaudnormWav, transcodeM4a } = createAudioClient(process.env)
const { localModelName, NEMOTRON_MODEL, localDiarizationProfiles, resolveLocalDiarizationModel } = require('./local-diarization.cjs')
const { nemotronStatus } = createAudioClient(process.env)
const { modelStatus: sileroModelStatus } = require('./silero-vad.cjs')
const { findIdentityCandidates, findMatches, identityCandidates, identityKey, decideIdentity, fastMatch } = require('./voiceprint-matching.cjs')
const { createStorage } = require('./storage/index.cjs')
const { createAuth } = require('./auth/index.cjs')
const { logger, newRequestId } = require('./logger.cjs')
const { requestLimits, upstreamRateLimit } = require('./request-limits.cjs')


const { RecordingChunks } = require('./recording-chunks.cjs')
const { executeIdempotent, hash: requestHash } = require('./idempotency.cjs')
const { createSharedLimits } = require('./shared-limits.cjs')
const sharedLimits = createSharedLimits(process.env, requestLimits())

const productTitleImage = (() => {
  const imagePath = (process.env.S2T_PRODUCT_TITLE_IMAGE || '').trim()
  if (!imagePath || !/^icon\/[A-Za-z0-9_./-]+\.png$/.test(imagePath) || imagePath.split('/').includes('..')) return ''
  try {
    const image = readFileSync(join(process.cwd(), imagePath))
    return image.length <= 2 * 1024 * 1024 ? `data:image/png;base64,${image.toString('base64')}` : ''
  } catch { return '' }
})()
const port = Number(process.env.S2T_WEB_PORT || 8787)
const processRole = process.env.S2T_PROCESS_ROLE || 'all'
if (!['all', 'api', 'audio-worker', 'audio-service'].includes(processRole)) throw new Error('S2T_PROCESS_ROLE 必須是 all、api、audio-worker 或 audio-service')
const maxAsrAudioBytes = 100 * 1024 * 1024
const service = (name) => ({
  endpoint: process.env[`S2T_${name}_ENDPOINT`] || '',
  model: process.env[`S2T_${name}_MODEL`] || '',
  apiKey: process.env[`S2T_${name}_API_KEY`] || ''
})
const asr = service('ASR')
const configuredAsrProfiles = (() => {
  const fallback = { id: 'default', name: asr.model || 'Environment ASR', ...asr }
  const raw = process.env.S2T_ASR_MODELS_JSON || ''
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
// An incomplete environment ASR profile used to pass readiness and only fail
// after a user pressed record with an opaque 503. Account-managed profiles may
// intentionally leave all three values empty, but a partial environment
// profile is always a deployment error and must keep this API Pod out of the
// Service endpoints.
const asrConfigurationError = [asr.endpoint, asr.model, asr.apiKey].some(Boolean) && ![asr.endpoint, asr.model, asr.apiKey].every(Boolean)
  ? new Error('環境 ASR 設定不完整；S2T_ASR_ENDPOINT、S2T_ASR_MODEL、S2T_ASR_API_KEY 必須同時設定')
  : null
const translation = service('TRANSLATION')
const summary = service('SUMMARY')
const diarization = service('DIARIZATION')
// Storage validates partial remote configuration at startup. Do not let a
// configuration typo make the process crash-loop: keep liveness available and
// expose the precise fault through readiness instead. API calls are rejected
// below until storage/auth can be initialized successfully.
let storage
let storageStartupError = null
try { storage = createStorage(process.env) } catch (error) {
  storageStartupError = error instanceof Error ? error : new Error('storage 設定無效')
  storage = { mode: { blob: 'unavailable', config: 'unavailable', vector: 'unavailable' }, config: {}, ready: Promise.reject(storageStartupError) }
}
const kubernetesConfigError = process.env.S2T_KUBERNETES_MODE === 'true' && Object.values(storage.mode).some((mode) => mode === 'local')
  ? new Error('Kubernetes 模式必須設定共享 MinIO、PostgreSQL 與 Milvus，不能使用 Pod 本地 storage')
  : null
const recordingChunks = new RecordingChunks(storage)
const audioConfigurationError = ((processRole === 'audio-service' || (processRole === 'api' && process.env.S2T_AUDIO_SERVICE_URL)) && !process.env.S2T_AUDIO_SERVICE_TOKEN) || (process.env.S2T_KUBERNETES_MODE === 'true' && processRole === 'api' && !process.env.S2T_AUDIO_SERVICE_URL) ? new Error('音訊服務必須設定 S2T_AUDIO_SERVICE_TOKEN；K8s API 必須設定 S2T_AUDIO_SERVICE_URL') : null
const startupError = storageStartupError || kubernetesConfigError || sharedLimits.configurationError || audioConfigurationError
const authReady = startupError ? Promise.reject(startupError) : createAuth(storage, process.env, sharedLimits)
// Readiness reports dependency failures, but a transient startup outage must
// not become an unhandled rejection that kills the Pod before probes can see
// the actionable 503. Keep the original promises rejected for callers that
// await them below.
storage.ready
  .then(() => logger.info('storage.ready', { mode: storage.mode, schemaVersion: storage.schemaVersion }))
  .catch((error) => logger.error('storage.unavailable', { mode: storage.mode, error }))
authReady
  .then(() => logger.info('auth.ready'))
  .catch((error) => logger.error('auth.unavailable', { error }))
if (startupError) logger.error('startup.failed', { role: processRole, error: startupError })
if (asrConfigurationError) logger.warn('asr.configuration.incomplete', { error: asrConfigurationError })
process.on('unhandledRejection', (reason) => logger.error('process.unhandled-rejection', { error: reason }))
// Optional warmup is explicit, preserving Docker's current startup behavior.
const audioWarmupReady = (async () => {
  const operations = (process.env.S2T_AUDIO_WARMUP || '').split(',').map(value => value.trim()).filter(Boolean)
  for (const operation of operations) {
    if (operation === 'silero') await warmSileroVad()
    else if (operation === 'nemotron') await nemotronStatus()
    else if (operation === 'diarization') {
      const { wavHeader } = require('./recording-chunks.cjs')
      await diarizeWav(Buffer.concat([wavHeader(32000, 16000), Buffer.alloc(32000)]))
    } else throw new Error('S2T_AUDIO_WARMUP 僅接受 silero、nemotron、diarization')
  }
})()
audioWarmupReady.catch(error => logger.warn('audio.warmup.failed', { error }))
const staticRoot = join(process.cwd(), 'out/renderer')
const allowedOrigins = new Set((process.env.S2T_WEB_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean))
const modelHealthChecks = new Map()
const acceptLimitedRequest = sharedLimits.accept
const requestLatency = new Map()
const modelHealthLastState = new Map()
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
  lines.push('# TYPE s2t_gateway_inflight_requests gauge', `s2t_gateway_inflight_requests ${activeHttpRequests}`)
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
// The browser only ever calls the same-origin gateway route (endpoint), so
// credentials and upstream CORS stay server-side. sourceEndpoint carries the
// original environment value for display only, so operators can see exactly
// which upstream URL the default model is wired to.
const publicService = (value, endpoint) => ({
  endpoint,
  sourceEndpoint: value.endpoint || endpoint,
  model: value.model,
  configured: Boolean(value.endpoint && value.model && value.apiKey)
})
const publicAsrProfile = (value) => ({ id: value.id, name: value.name, endpoint: '/api/transcriptions', sourceEndpoint: value.endpoint || '/api/transcriptions', model: value.model, configured: Boolean(value.endpoint && value.model && value.apiKey) })
const normalizeDetectedLanguage = (value) => {
  if (typeof value !== 'string') return undefined
  const language = value.toLowerCase()
  if (language.startsWith('zh')) return 'zh-TW'
  if (language.startsWith('en')) return 'en-US'
  if (language.startsWith('ja')) return 'ja-JP'
  if (language.startsWith('de')) return 'de-DE'
  return undefined
}
const completeText = async (value, messages, maxRetries = 1) => {
  const client = new OpenAI({ apiKey: value.apiKey, baseURL: baseUrl(value.endpoint), timeout: 30_000, maxRetries })
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
const isLocalEndpoint = (endpoint) => typeof endpoint === 'string' && (endpoint === 's2t-local://diarization' || endpoint.startsWith('/api/') || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(endpoint))
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
    if (model.purpose === 'diarization' && model.model === NEMOTRON_MODEL) {
      if (!existsSync(paths.embedding)) throw new Error('找不到姓名辨識所需的 sherpa embedding 模型')
      await nemotronStatus()
      return { id: model.id, state: 'healthy', reason: 'Nemotron CPU runtime、權重校驗與 embedding 已就緒（最多 8 人）', checkedAt }
    }
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
const sileroHealth = async (model) => {
  const checkedAt = Date.now()
  try {
    const status = await warmSileroVad()
    return { id: model.id, state: 'healthy', reason: 'Silero VAD 模型、checksum 與 ONNX runtime 已載入', checkedAt }
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
  try {
    const value = await pending
    modelHealthChecks.set(key, { value })
    // Only log a transition: a Pod that is missing a model file would
    // otherwise repeat the same warning on every cached probe refresh.
    const previous = modelHealthLastState.get(key)
    modelHealthLastState.set(key, value.state)
    if (previous !== value.state) {
      const fields = { modelId: model.id, purpose: model.purpose, state: value.state, reason: value.reason }
      if (value.state === 'healthy') logger.info('model.health', fields)
      else if (value.state === 'unknown') logger.debug('model.unknown', fields)
      else logger.warn('model.unavailable', fields)
    }
    return value
  } finally { const current = modelHealthChecks.get(key); if (current?.pending === pending) modelHealthChecks.delete(key) }
}
const send = (response, status, body, type = 'application/json; charset=utf-8') => {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
// Request-shape validation returns 400 at the call site. Once a valid storage
// request reaches an adapter, failures are transient dependency failures and
// must be 503 so Web clients can retry instead of abandoning durable state.
// The access log records the status; this line carries the reason, which is
// what an operator needs (Postgres down vs. MinIO down vs. Milvus down).
const storageFailure = (response, error, fallback) => {
  const status = [400, 413, 415, 503].includes(error?.status) ? error.status : error instanceof SyntaxError ? 400 : 503
  if (status >= 500) logger.warn('storage.request.failed', { status, error })
  return send(response, status, { error: error instanceof Error ? error.message : fallback })
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
const decodedHeaderValue = (value) => {
  const text = typeof value === 'string' ? value : ''
  try { return decodeURIComponent(text) } catch { return text }
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
const withProtectedAudioUpload = async (user, id, operation) => {
  const token = randomUUID()
  const refresh = () => updateAudioCompensations(user, entries => {
    const item = entries.find(entry => entry.id === id) || { id, createdAt: new Date().toISOString(), eligibleAfter: Date.now() + compensationGraceMs }
    const leases = (item.uploadLeases || []).filter(lease => lease.token !== token && lease.until > Date.now())
    return [...entries.filter(entry => entry.id !== id), { ...item, uploadLeases: [...leases, { token, until: Date.now() + 120000 }] }]
  })
  await refresh()
  let lost = false, renewing = false
  const timer = setInterval(() => {
    if (renewing || lost) return
    renewing = true
    refresh().catch(() => { lost = true }).finally(() => { renewing = false })
  }, 15000)
  timer.unref()
  try { await operation(); if (lost) throw new Error('音訊保存協調失敗，請重試') }
  finally {
    clearInterval(timer)
    await updateAudioCompensations(user, entries => entries.map(item => item.id !== id ? item : { ...item, eligibleAfter: Date.now() + compensationGraceMs, uploadLeases: (item.uploadLeases || []).filter(lease => lease.token !== token && lease.until > Date.now()) }))
  }
}

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
const voiceprintLog = (event) => { if (voiceprintLogEnabled) logger.info('voiceprint.event', event) }
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
    if (item.uploadLeases?.some(lease => lease.until > Date.now())) continue
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
  for (const record of await storage.config.list(user.id, 'recording-')) {
    if (record.value?.chunks && ['recording', 'finishing', 'completed'].includes(record.value.state)) referenced.add(record.key.slice('recording-'.length))
  }
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
    logger.warn('diarization.job.abandoned', { jobId: job.id, attempt: job.attempts, maxAttempts: diarizationJobMaxAttempts, owner })
    await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration, `超過最大重試次數（${diarizationJobMaxAttempts}）`).catch(() => undefined)
    return
  }
  let leaseLost = false
  let renewingLease = false
  const leaseTimer = typeof storage.config.renewDiarizationJob === 'function' ? setInterval(() => {
    if (renewingLease || leaseLost) return
    renewingLease = true
    storage.config.renewDiarizationJob(job.id, owner, job.leaseGeneration)
      .then(owned => { if (!owned) leaseLost = true })
      .catch(error => { leaseLost = true; logger.warn('diarization.job.renew.failed', { jobId: job.id, error }) })
      .finally(() => { renewingLease = false })
  }, 30000) : null
  leaseTimer?.unref()
  const jobStartedAt = Date.now()
  logger.info('diarization.job.started', { jobId: job.id, attempt: job.attempts, sessionId: job.sessionId, owner })
  try {
    const user = job.payload?.user
    if (!user?.id || user.id !== job.userId) throw new Error('工作使用者資料無效')
    const initial = await storage.config.get(user.id, 'sessions')
    const target = initial?.sessions?.find(session => session.id === job.sessionId)
    if (!target) throw new Error('retry:紀錄尚未同步完成')
    if (job.payload?.processingToken && target.processingToken === job.payload.processingToken && target.processingStage !== 'diarization' && target.processingState === 'running') throw new Error('retry:紀錄尚未完成尾段處理')
    if (!matchesJob(target, job)) {
      if (job.payload?.processingToken && target.processingToken !== job.payload.processingToken) {
        await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration)
        return
      }
      throw new Error('retry:紀錄音訊版本尚未同步完成')
    }

    const audio = await storage.blob.get(user.id, `audio/${job.audioKey}`)
    if (!audio) throw new Error('找不到講者分離工作對應的音檔')
    // Background jobs use the deployment service before account defaults.
    const selected = job.payload?.localModel ? null : diarization.model ? diarization : await accountModelService(auth, user, job.payload?.modelId || 'managed-diarization', 'diarization')
    let rawTurns
    if (selected?.endpoint && selected.model) {
      const headers = selected.apiKey ? { authorization: `Bearer ${selected.apiKey}` } : {}
      const form = new FormData(); form.set('model', selected.model); form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
      const remote = await fetch(selected.endpoint, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(120_000) })
      const payload = await remote.json().catch(() => null)
      if (!remote.ok || !payload) throw new Error(`講者分離服務 HTTP ${remote.status}`)
      rawTurns = diarizationTurns(payload)
    } else rawTurns = await diarizeWav(audio, resolveLocalDiarizationModel(job.payload?.localModel))
    const turns = await labelDiarizationTurns(user, audio, rawTurns)
    if (!turns.length) throw new Error('講者分離服務沒有回傳有效區段')
    const stored = await storage.config.get(user.id, 'sessions')
    const sessions = Array.isArray(stored?.sessions) ? stored.sessions : []
    const version = Number.isSafeInteger(stored?.version) ? stored.version : 0
    let matched = false
    const next = sessions.map((session) => {
      if (!matchesJob(session, job)) return session
      matched = true
      return finalizeDiarizationSession(session, job, turns)
    })
    if (!matched) throw new Error('retry:紀錄尚未同步完成')
    if (leaseLost) return
    const committed = await storage.config.commitDiarizationJob(job.id, owner, job.leaseGeneration, user.id, version, { sessions: next, version: version + 1 })
    if (committed === 'lost') return
    if (committed === 'conflict') throw new Error('retry:紀錄已更新，背景工作將重試')
    logger.info('diarization.job.completed', { jobId: job.id, attempt: job.attempts, durationMs: Date.now() - jobStartedAt, turns: turns.length })
  } catch (error) {
    const reason = error instanceof Error ? error.message : '背景講者分離失敗'
    const fields = { jobId: job.id, attempt: job.attempts, durationMs: Date.now() - jobStartedAt, error }
    // A job that lost a race or has not synced yet is expected to retry; a
    // real failure is an error so an operator sees it without debug logging.
    if (reason.startsWith('retry:')) logger.warn('diarization.job.retry', fields)
    else logger.error('diarization.job.failed', fields)
    if (!leaseLost) await storage.config.finishDiarizationJob(job.id, owner, job.leaseGeneration, reason)
  } finally { if (leaseTimer) clearInterval(leaseTimer) }
}
const staticFile = async (request, response) => {
  const urlPath = new URL(request.url, 'http://localhost').pathname
  const requested = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '')
  const filePath = join(staticRoot, normalize(requested).replace(/^\.\.(\/|\\|$)/, ''))
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    const content = await readFile(filePath)
    const type = filePath.endsWith('.js') ? 'text/javascript' : filePath.endsWith('.css') ? 'text/css' : filePath.endsWith('.html') ? 'text/html' : filePath.endsWith('.svg') ? 'image/svg+xml' : filePath.endsWith('.png') ? 'image/png' : filePath.endsWith('.ico') ? 'image/x-icon' : 'application/octet-stream'
    send(response, 200, content, type)
  } catch {
    try { send(response, 200, await readFile(join(staticRoot, 'index.html')), 'text/html') } catch { send(response, 404, { error: 'Web build not found. Run npm run build first.' }) }
  }
}
const acceptsRequest = (request, bucket, userId) => acceptLimitedRequest(
  userId ? `user:${userId}` : `ip:${request.socket.remoteAddress || 'unknown'}`, bucket)
const rateLimitResponse = (response, result, message) => {
  response.setHeader('retry-after', String(result.retryAfterSeconds))
  return send(response, 429, { error: message, retryAfterSeconds: result.retryAfterSeconds })
}

let acceptingDiarizationJobs = true
let activeDiarizationJob = null
let pruningRequests = false
const requestCleanup = setInterval(() => {
  if (pruningRequests || draining || typeof storage.config.pruneExpiredRequests !== 'function') return
  pruningRequests = true
  storage.config.pruneExpiredRequests().catch(error => logger.warn('requests.cleanup.failed', { error })).finally(() => { pruningRequests = false })
}, 60000)
requestCleanup.unref()
if (['all', 'audio-worker'].includes(processRole) && typeof storage.config.claimDiarizationJob === 'function') {
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

const handleHttpRequest = async (request, response) => {
  // Liveness is intentionally independent of every downstream service. It
  // lets Kubernetes restart a stuck Node process without amplifying a storage
  // outage. Readiness below verifies the shared durable state instead.
  if (request.method === 'GET' && request.url === '/livez') return send(response, 200, { live: true, role: processRole })
  if (request.method === 'GET' && request.url === '/metrics') {
    let backlog = ''
    if (typeof storage.config.diarizationBacklog === 'function') {
      try { const value = await storage.config.diarizationBacklog(); backlog = `# TYPE s2t_diarization_pending_jobs gauge\ns2t_diarization_pending_jobs ${value.pending}\n# TYPE s2t_diarization_pending_audio_seconds gauge\ns2t_diarization_pending_audio_seconds ${value.audioSeconds}\n# TYPE s2t_diarization_oldest_seconds gauge\ns2t_diarization_oldest_seconds ${value.oldest}\n` } catch { /* Keep independent gateway metrics available during DB outages. */ }
    }
    return send(response, 200, prometheusMetrics() + backlog, 'text/plain; version=0.0.4; charset=utf-8')
  }
  if (request.method === 'GET' && request.url === '/readyz') {
    try { if (startupError) throw startupError; if (['all', 'api'].includes(processRole) && asrConfigurationError) throw asrConfigurationError; if (quiescing || draining) throw new Error('服務正在排空'); await storage.ready; await authReady; await audioWarmupReady; await sharedLimits.health(); return send(response, 200, { ready: true, role: processRole, storage: storage.mode }) }
    catch (error) { return send(response, 503, { ready: false, role: processRole, error: error instanceof Error ? error.message : 'storage 尚未就緒' }) }
  }
  // The worker has a probe-only HTTP surface. It deliberately cannot serve
  // authenticated API traffic, but Kubernetes can still restart it when its
  // process or shared durable dependencies are unhealthy.
  if (processRole === 'audio-service') {
    if (startupError) return send(response, 503, { error: startupError.message })
    try { return await handleAudioService(request, response, readBody, send) } catch (error) { if (!response.headersSent) return send(response, error.status || 503, { error: error.message }); response.destroy() }
  }
  if (processRole === 'audio-worker') return send(response, 404, { error: 'audio worker only exposes health probes' })
  const origin = request.headers.origin
  const host = request.headers.host || ''
  const sameOrigin = origin === `http://${host}` || origin === `https://${host}`
  if (origin && !sameOrigin && !allowedOrigins.has(origin)) return send(response, 403, { error: 'Origin is not allowed.' })
  if (origin) { response.setHeader('access-control-allow-origin', origin); response.setHeader('access-control-allow-credentials', 'true'); response.setHeader('access-control-expose-headers', 'x-request-id,retry-after') }
  response.setHeader('vary', 'Origin')
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, content-encoding, x-request-id, x-s2t-language, x-s2t-model-id, x-s2t-diarization-model, x-s2t-prompt, x-s2t-filename, x-s2t-dynaudnorm, x-s2t-voiceprint-sharing, x-s2t-voiceprint-consent, x-s2t-idempotency-key, x-s2t-start-sample, x-s2t-sample-rate', 'access-control-allow-credentials': 'true' }); return response.end() }
  // authReady rejects when storage/auth cannot initialise (for example a
  // failed schema migration). Answer 503 instead of letting that rejection
  // escape the request listener: an unhandled rejection would crash the whole
  // gateway on its first API request.
  if (startupError) return send(response, 503, { error: startupError.message })
  let auth
  try { auth = await authReady } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'storage 尚未就緒，無法處理請求' }) }
  const requestPath = new URL(request.url, 'http://localhost').pathname
  const startedAt = performance.now()
  response.once('finish', () => observeRequest(requestPath, response.statusCode, startedAt))
  if (await auth.handle(request, response, send)) return
  if (request.method === 'GET' && request.url === '/api/config') return send(response, 200, {
    capabilities: { durableRecordingChunks: true, distributed: process.env.S2T_KUBERNETES_MODE === 'true' },
    branding: { titleImage: productTitleImage },
    asr: publicService(asr, '/api/transcriptions'),
    asrProfiles: configuredAsrProfiles.map(publicAsrProfile),
    translation: publicService(translation, '/api/translations'),
    summary: publicService(summary, '/api/summaries'),
    diarizationProfiles: localDiarizationProfiles(),
    diarization: diarization.endpoint && diarization.model
      ? publicService(diarization, '/api/diarizations')
      : { endpoint: '/api/diarizations', model: localModelName(), configured: true }
  })
  if (request.method === 'GET' && request.url === '/api/storage') {
    // compensationGraceMs lets integration tests wait out the in-flight
    // protection window instead of guessing the gateway's configuration.
    try { await storage.ready; return send(response, 200, { mode: storage.mode, schemaVersion: storage.schemaVersion, ready: true, compensationGraceMs }) }
    catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'Storage is unavailable', mode: storage.mode, schemaVersion: storage.schemaVersion, ready: false, compensationGraceMs }) }
  }
  const storagePath = new URL(request.url, 'http://localhost').pathname
  const recordingMatch = /^\/api\/data\/recordings\/([A-Za-z0-9._-]{1,120})(?:\/(chunks)\/(\d+)|(\/(?:finish|promote)))?$/.exec(storagePath)
  if (recordingMatch) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const id = recordingMatch[1]
    try {
      if (request.method === 'DELETE' && !recordingMatch[2] && !recordingMatch[4]) { await recordingChunks.removeCompleted(user.id, id); return send(response, 204, '') }
      if (request.method === 'GET' && !recordingMatch[2] && !recordingMatch[4]) {
        const value = await recordingChunks.status(user.id, id)
        return value ? send(response, 200, { sampleRate: value.sampleRate, state: value.state, contiguousChunks: value.contiguousChunks, persistedSamples: value.persistedSamples, audioKey: value.audioKey }) : send(response, 404, { error: '找不到錄音' })
      }
      if (request.method === 'PUT' && recordingMatch[2]) {
        const audio = await readBody(request, 1024 ** 2)
        return send(response, 200, await recordingChunks.append(user.id, id, Number(recordingMatch[3]), Number(request.headers['x-s2t-start-sample']), Number(request.headers['x-s2t-sample-rate']), audio))
      }
      if (request.method === 'POST' && recordingMatch[4] === '/promote') {
        const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
        if (typeof body.audioKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(body.audioKey) || body.audioKey === id) return send(response, 400, { error: '無效的正式音訊 ID' })
        const value = await recordingChunks.status(user.id, id)
        if (value?.state !== 'completed') return send(response, 409, { error: '錄音尚未完成' })
        const audio = await storage.blob.readStream(user.id, `audio/${id}`)
        if (!audio) return send(response, 503, { error: '錄音備份暫時不可用' })
        await withProtectedAudioUpload(user, body.audioKey, () => storage.blob.putStream(user.id, `audio/${body.audioKey}`, audio, value.persistedSamples * 2 + 44))
        return send(response, 201, { saved: true, pendingSessionCommit: true })
      }
      if (request.method === 'POST' && recordingMatch[4]) {
        const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
        return send(response, 200, await recordingChunks.finish(user.id, id, body.totalChunks, body.totalSamples))
      }
      return send(response, 405, { error: 'Method not allowed' })
    } catch (error) { return send(response, error.status || (error instanceof SyntaxError ? 400 : 503), { error: error.message }) }
  }
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
      return await withSessionWrite(async () => {
      if (request.destroyed) throw Object.assign(new Error('紀錄同步傳輸中斷'), { status: 400 })
      const body = await readSessionPayload(request)
      if (!body || typeof body !== 'object' || !Array.isArray(body.sessions) || !Number.isSafeInteger(body.version) || body.version < 0) return send(response, 400, { error: 'sessions 與 version 必須有效' })
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
      })
    } catch (error) {
      // Finish the structured error before closing an unread/oversized body.
      if (!request.complete) { response.setHeader('connection', 'close'); response.once('finish', () => request.destroy()) }
      if (error?.status === 503) response.setHeader('retry-after', '1')
      return storageFailure(response, error, '無法保存紀錄')
    }
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
    } catch (error) { return storageFailure(response, error, '無法保存術語') }
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
    } catch (error) { return storageFailure(response, error, '無法保存設定') }
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
    } catch (error) { return storageFailure(response, error, '暫存資料保存失敗') }
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
    } catch (error) { return storageFailure(response, error, '無法保存模型清單') }
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
      // Silero is image/volume configuration rather than an account model, so
      // add it explicitly: it must be visible in the same health surface as
      // remote models and never depend on browser storage being populated.
      add({ id: 'managed-silero-vad', name: 'Silero VAD', endpoint: '/api/audio-processing/silero-vad', model: 'silero-vad', purpose: 'asr' })
      add({ id: 'web-environment-translation', name: translation.model, endpoint: translation.endpoint, model: translation.model, purpose: 'translation', service: { endpoint: translation.endpoint, model: translation.model, apiKey: translation.apiKey } })
      add({ id: 'managed-summary', name: summary.model, endpoint: summary.endpoint, model: summary.model, purpose: 'summary', service: { endpoint: summary.endpoint, model: summary.model, apiKey: summary.apiKey } })
      for (const profile of localDiarizationProfiles()) add({ ...profile, purpose: 'diarization' })
      add({ id: 'managed-diarization', name: diarization.model || localModelName(), endpoint: diarization.endpoint || '/api/diarizations', model: diarization.model || localModelName(), purpose: 'diarization', service: { endpoint: diarization.endpoint, model: diarization.model, apiKey: diarization.apiKey } })
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
    const user = await auth.requireUser(request)
    const limit = await acceptsRequest(request, 'silero-vad', user?.id)
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many Silero VAD requests. Try again later.')
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
  if (storagePath === '/api/audio-processing/import-wav' && request.method === 'POST') {
    const user = await auth.requireUser(request)
    const limit = await acceptsRequest(request, 'transcode', user?.id)
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many import conversions.')
    if (!user) return send(response, 401, { error: '需要登入' })
    if (Number(request.headers['content-length']) > MAX_IMPORT_BYTES) return send(response, 413, { error: '匯入檔案不可超過 2 GB。' })
    if (processRole === 'api' && process.env.S2T_AUDIO_SERVICE_URL) return proxyImport(request, response)
    const controller = new AbortController()
    const abort = () => { if (!response.writableFinished) controller.abort() }
    request.once('aborted', abort); response.once('close', abort)
    let converted
    try {
      converted = await convertImportAudio(request, { signal: controller.signal })
      response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': converted.size, 'cache-control': 'no-store' })
      await pipeline(createReadStream(converted.path), response, { signal: controller.signal })
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, error.status || 503, { error: error.message || '匯入轉換失敗' })
    } finally {
      request.removeListener('aborted', abort); response.removeListener('close', abort)
      if (converted) await converted.dispose()
    }
    return
  }
  if (storagePath === '/api/audio-processing/transcode' && request.method === 'POST') {
    const format = new URL(request.url, 'http://localhost').searchParams.get('format')
    if (format !== 'm4a') return send(response, 400, { error: '目前只支援轉檔為 M4A' })
    const user = await auth.requireUser(request)
    const limit = await acceptsRequest(request, 'transcode', user?.id)
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many transcode requests. Try again later.')
    if (!user) return send(response, 401, { error: '需要登入' })

    try {
      if (!safeAudioContentType(request.headers['content-type'])) return send(response, 415, { error: '轉檔僅接受支援的音訊格式' })
      const audio = await readBody(request, maxAsrAudioBytes)
      if (!audio.length) return send(response, 400, { error: '音訊不可為空' })
      return send(response, 200, await transcodeM4a(audio), 'audio/mp4')
    } catch (error) { return send(response, 503, { error: error instanceof Error ? error.message : 'M4A 轉檔失敗' }) }
  }
  if (storagePath === '/api/data/diarization-jobs' && (request.method === 'POST' || request.method === 'GET' || request.method === 'DELETE')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    if (typeof storage.config.enqueueDiarizationJob !== 'function') return send(response, 503, { error: '目前 storage 不支援持久化講者分離工作' })
    try {
      if (request.method === 'GET' || request.method === 'DELETE') {
        const id = new URL(request.url, 'http://localhost').searchParams.get('id') || ''
        if (!id) return send(response, 400, { error: 'job id 必須有效' })
        if (request.method === 'DELETE') { await storage.config.removeDiarizationJob(user.id, id); return send(response, 204, '') }
        const job = await storage.config.getDiarizationJob(user.id, id)
        return job ? send(response, 200, { job }) : send(response, 404, { error: '找不到講者分離工作' })
      }
      const body = JSON.parse((await readBody(request, 32 * 1024)).toString('utf8'))
      if (typeof body.sessionId !== 'string' || typeof body.audioKey !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(body.audioKey)) return send(response, 400, { error: 'sessionId 與 audioKey 必須有效' })
      const sessionMetadata = await storage.config.get(user.id, 'sessions')
      const sessionDuration = sessionMetadata?.sessions?.find(session => session.id === body.sessionId)?.durationMs
      const audioSeconds = Number.isFinite(sessionDuration) && sessionDuration > 0 ? sessionDuration / 1000 : 60
      const job = await storage.config.enqueueDiarizationJob({ id: randomUUID(), userId: user.id, sessionId: body.sessionId, audioKey: body.audioKey, payload: { user: { id: user.id, NT: user.NT, Department: user.Department }, modelId: 'managed-diarization', audioSeconds, ...(body.localModel ? { localModel: resolveLocalDiarizationModel(body.localModel) } : {}), ...(typeof body.processingToken === 'string' ? { processingToken: body.processingToken } : {}) } })
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
    } catch (error) { return storageFailure(response, error, '無法保存 API key') }
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
    } catch (error) { return storageFailure(response, error, '無法保存摘要模板') }
  }
  const audioMatch = storagePath.match(/^\/api\/data\/audio\/([A-Za-z0-9._-]{1,160})$/)
  if (audioMatch && ['GET', 'POST', 'DELETE'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    const audioKey = `audio/${audioMatch[1]}`
    try {
      if (request.method === 'POST') {
        const limit = await acceptsRequest(request, 'audioUploads', user.id)
        if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many audio uploads. Try again later.')
        const maximum = process.env.S2T_KUBERNETES_MODE === 'true' ? 2 * 1024 ** 3 : 1024 ** 3
        const declaredSize = Number(request.headers['content-length'])
        if (request.headers['content-length'] === '0') return send(response, 400, { error: '音檔不可為空' })
        if (declaredSize > maximum) return send(response, 413, { error: '音檔超過大小上限' })
        let bytes = 0
        const limited = new Transform({
          transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > maximum ? new Error('音檔超過大小上限') : null, chunk) },
          flush(callback) { callback(bytes ? null : new Error('音檔不可為空')) }
        })
        try { await withProtectedAudioUpload(user, audioMatch[1], () => Promise.all([pipeline(request, limited), storage.blob.putStream(user.id, audioKey, limited, Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : undefined)])) }
        catch (error) { limited.destroy(); throw error }
        return send(response, 201, { saved: true, pendingSessionCommit: true })
      }
      if (request.method === 'DELETE') { await storage.blob.remove(user.id, audioKey); await dropAudioCompensation(user, audioMatch[1]); return send(response, 204, '') }
      const audio = await storage.blob.readStream(user.id, audioKey)
      if (!audio) return send(response, 404, { error: '找不到音檔' })
      response.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
      return await pipeline(audio, response)
    } catch (error) { if (response.headersSent) return response.destroy(); return storageFailure(response, error, '音檔操作失敗') }
  }
  if (storagePath === '/api/voiceprints' && ['GET', 'POST'].includes(request.method || '')) {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      await reconcileVoiceprintCompensations(user)
      if (request.method === 'GET') return send(response, 200, { voiceprints: await ownVoiceprints(user) })
      // Enrolment bodies are buffered up to 500 MB; bound how fast one client
      // can ask for more of them.
      const limit = await acceptsRequest(request, 'voiceprintUploads', user.id)
      if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many voiceprint requests. Try again later.')
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: '聲紋註冊需要 WAV 音檔' })
      const sharingScope = String(request.headers['x-s2t-voiceprint-sharing'] || 'private')
      if (!['private', 'department', 'organization'].includes(sharingScope)) return send(response, 400, { error: '無效的聲紋共享範圍' })
      if (sharingScope !== 'private' && request.headers['x-s2t-voiceprint-consent, x-s2t-idempotency-key, x-s2t-start-sample, x-s2t-sample-rate'] !== 'true') return send(response, 400, { error: '分享聲紋前必須明確同意比對用途' })
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
      const limit = await acceptsRequest(request, 'voiceprintUploads', user.id)
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
    const user = await auth.requireUser(request)
    const limit = await acceptsRequest(request, 'transcriptions', user?.id)
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many transcription requests. Try again later.')
    if (!user) return send(response, 401, { error: '需要登入' })
    const profileId = String(request.headers['x-s2t-model-id'] || 'default')
    const environmentAsr = asrProfileById.get(profileId)
    const selectedAsr = environmentAsr || await accountModelService(auth, user, profileId, 'asr')
    if (!selectedAsr) return send(response, 400, { error: 'The requested ASR model is not registered on this gateway.' })
    if (!selectedAsr.endpoint || !selectedAsr.model || (environmentAsr && !selectedAsr.apiKey)) return send(response, 503, { error: 'Web ASR gateway has not been configured.' })
    const asrStartedAt = Date.now()
    let asrAudioBytes = 0
    try {
      const contentType = safeAudioContentType(request.headers['content-type'])
      if (!contentType) return send(response, 415, { error: 'Unsupported audio content type. Use WAV, MP3, M4A/AAC, OGG, WebM, FLAC, MP4, or MOV.' })
      const requestedLanguage = String(request.headers['x-s2t-language'] || '')
      if (requestedLanguage && !['zh', 'en', 'ja', 'de'].includes(requestedLanguage)) return send(response, 400, { error: 'Unsupported ASR language. Use zh, en, ja, de, or omit it for automatic detection.' })
      let audio = await readBody(request, maxAsrAudioBytes)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      asrAudioBytes = audio.length
      const fingerprint = requestHash(Buffer.concat([audio, Buffer.from(JSON.stringify({ contentType, requestedLanguage, prompt: request.headers['x-s2t-prompt'] || '', filename: request.headers['x-s2t-filename'] || '', dynaudnorm: request.headers['x-s2t-dynaudnorm'] || '', model: selectedAsr.model, endpoint: selectedAsr.endpoint, credential: requestHash(selectedAsr.apiKey || '') }))]))
      const output = await executeIdempotent(storage.config, user.id, '/api/transcriptions', request.headers['x-s2t-idempotency-key'], fingerprint, () => sharedLimits.withCapacity('asr', async () => {
      if (request.headers['x-s2t-dynaudnorm'] === 'true') audio = await dynaudnormWav(audio)
      // Never the prompt itself, the audio or the transcript — only sizes.
      logger.debug('asr.started', { profileId, model: selectedAsr.model, language: requestedLanguage || 'auto', contentType, audioBytes: asrAudioBytes })
      const client = new OpenAI({ apiKey: selectedAsr.apiKey, baseURL: baseUrl(selectedAsr.endpoint), timeout: 20_000, maxRetries: 0 })
      const result = await client.audio.transcriptions.create({
        file: await toFile(audio, safeUploadFilename(decodedHeaderValue(request.headers['x-s2t-filename'])), { type: contentType }), model: selectedAsr.model,
        ...(requestedLanguage ? { language: requestedLanguage } : {}),
        ...(request.headers['x-s2t-prompt'] ? { prompt: decodedHeaderValue(request.headers['x-s2t-prompt']).slice(0, 10_000) } : {})
      })
      logger.debug('asr.completed', { profileId, model: selectedAsr.model, durationMs: Date.now() - asrStartedAt, audioBytes: asrAudioBytes, chars: (result.text || '').length })
      return { text: result.text || '', detectedLanguage: normalizeDetectedLanguage(result.language) }
      }))
      return send(response, 200, output)
    } catch (error) {
      logger.error('asr.failed', {
        profileId,
        model: selectedAsr.model,
        audioBytes: asrAudioBytes,
        status: error && typeof error === 'object' ? error.status || error.statusCode : undefined,
        durationMs: Date.now() - asrStartedAt,
        error
      })
      const rateLimit = upstreamRateLimit(error)
      if (rateLimit) return rateLimitResponse(response, rateLimit, 'ASR provider temporarily rate limited. Try again later.')
      return send(response, [400, 409, 503].includes(error?.status) ? error.status : 502, { error: error instanceof Error ? error.message : 'ASR request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/translations') {
    const user = await auth.requireUser(request)
    const limit = await acceptsRequest(request, 'translations', user?.id)
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many translation requests. Try again later.')
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
      // The source text and the glossary stay out of the console; sizes and
      // language pair are enough to follow a slow or failing translation.
      logger.debug('translation.request', { profileId, sourceLanguage, targetLanguage, glossary: glossary ? 'provided' : 'none', chars: text.length })
      const translationStartedAt = Date.now()
      const textResult = await executeIdempotent(storage.config, user.id, '/api/translations', request.headers['x-s2t-idempotency-key'], requestHash(JSON.stringify({ text, sourceLanguage, targetLanguage, glossary, model: selectedTranslation.model, endpoint: selectedTranslation.endpoint, credential: requestHash(selectedTranslation.apiKey || '') })), () => sharedLimits.withCapacity('translation', () => completeText(selectedTranslation, [{ role: 'user', content: hyTranslationPrompt(text, sourceLanguage, targetLanguage, glossary) }], 0)))
      logger.debug('translation.completed', { profileId, sourceLanguage, targetLanguage, durationMs: Date.now() - translationStartedAt, chars: (textResult || '').length })
      return send(response, 200, { text: textResult })
    } catch (error) {
      const rateLimit = upstreamRateLimit(error)
      if (rateLimit) return rateLimitResponse(response, rateLimit, 'Translation provider temporarily rate limited. Try again later.')
      return send(response, [400, 409, 503].includes(error?.status) ? error.status : 502, { error: error instanceof Error ? error.message : 'Translation request failed' })
    }
  }
  if (request.method === 'POST' && request.url === '/api/summaries') {
    const user = await auth.requireUser(request)
    const limit = await acceptsRequest(request, 'summaries', user?.id)
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many summary requests. Try again later.')
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
    const user = await auth.requireUser(request)
    const limit = await acceptsRequest(request, 'diarizations', user?.id)
    if (!limit.accepted) return rateLimitResponse(response, limit, 'Too many diarization requests. Try again later.')
    if (!user) return send(response, 401, { error: '需要登入' })

    try {
      const audio = await readBody(request, 500 * 1024 * 1024)
      if (!audio.length) return send(response, 400, { error: 'Audio is required.' })
      const profileId = String(request.headers['x-s2t-model-id'] || '')
      const selectedDiarization = request.headers['x-s2t-diarization-model'] ? null : profileId ? await accountModelService(auth, user, profileId, 'diarization') : diarization
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
      const localModel = resolveLocalDiarizationModel(String(request.headers['x-s2t-diarization-model'] || ''))
      const segments = await diarizeWav(audio, localModel)
      const labeledSegments = await labelDiarizationTurns(user, audio, segments)
      const payload = { model: localModel, ...(localModel === NEMOTRON_MODEL ? { speaker_capacity: 8, runtime: 'cpu', preset: 'v3-offline', speaker_cache_frames: 528 } : {}), threshold: voiceprintThreshold, exclusive_diarization: labeledSegments }
      // Only the sliding-window preview asks for these. The full-track pass
      // would pay the same RTF across the entire recording for a signal only
      // the stabilizer reads, so the cost stays opt-in per request.
      if (request.headers['x-s2t-speaker-embeddings'] === '1') {
        try {
          payload.speaker_embeddings = await extractSpeakerLabelEmbeddings(audio, segments)
        } catch (error) {
          logger.debug('diarization.embeddings.failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
      return send(response, 200, payload)
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : 'Speaker diarization failed' })
    }
  }
  return staticFile(request, response)
}
// One requestId per HTTP request. It is generated here (or adopted from a
// trusted inbound x-request-id) and stored in an AsyncLocalStorage context so
// every log emitted while handling the request — ASR, translation, storage,
// background jobs started from it — carries the same ID.
const incomingRequestId = (request) => {
  const header = request.headers['x-request-id']
  if (typeof header === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(header)) return header
  return newRequestId()
}
const requestPathOf = (request) => {
  try { return new URL(request.url, 'http://localhost').pathname } catch { return 'unknown' }
}
// Health probes and static assets are noise at info level: they would drown
// the business events on every Pod. Everything an operator acts on stays at
// warn/error so it is visible with the default S2T_LOG_LEVEL.
const probePaths = new Set(['/livez', '/metrics'])
const httpLogLevel = (status, probe) => {
  if (status === 503 || status === 429 || status === 409) return 'warn'
  if (status >= 500) return 'error'
  if (status >= 400) return probe || status === 401 || status === 403 ? 'info' : 'warn'
  return probe ? 'debug' : 'info'
}
let quiescing = false
let draining = false
const activeHttpResponses = new Set()
let activeHttpRequests = 0
let httpDrained
const httpDrainedPromise = new Promise(resolve => { httpDrained = resolve })
const httpServer = createServer((request, response) => {
  activeHttpRequests += 1
  activeHttpResponses.add(response)
  if (quiescing) response.setHeader('connection', 'close')
  response.once('close', () => { activeHttpResponses.delete(response); activeHttpRequests -= 1; if (draining && activeHttpRequests === 0) httpDrained() })
  const requestId = incomingRequestId(request)
  const path = requestPathOf(request)
  const startedAt = performance.now()
  const probe = probePaths.has(path) || !path.startsWith('/api/')
  response.setHeader('x-request-id', requestId)
  response.once('finish', () => {
    logger.log(httpLogLevel(response.statusCode, probe), 'http.request', {
      method: request.method,
      path,
      status: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt)
    })
  })
  logger.run({ requestId }, () => {
    if (draining && request.url !== '/livez' && request.url !== '/readyz') { response.setHeader('connection', 'close'); return send(response, 503, { error: '服務正在排空，請重試' }) }
    void handleHttpRequest(request, response).catch((error) => {
      logger.error('http.request.failed', {
        method: request.method,
        path,
        durationMs: Math.round(performance.now() - startedAt),
        error
      })
      if (!response.headersSent && !response.writableEnded) send(response, 503, { error: '服務暫時無法處理此請求，請稍後重試' })
      else response.destroy()
    })
  })
}).on('error', (error) => logger.error('http.server.error', { port, role: processRole, error })).listen(port, () => {
  logger.info('gateway.started', { port, role: processRole, storage: storage.mode, logLevel: process.env.S2T_LOG_LEVEL || 'info', logFormat: process.env.S2T_LOG_FORMAT || 'text' })
  if (processRole === 'audio-worker') logger.info('audio-worker.started', { port, durableDiarizationJobs: true })
})

// Kubernetes withdraws endpoints asynchronously. During preStop, keep serving
// traffic that still reaches us, but finish keep-alive connections normally so
// clients move to another Pod before SIGTERM closes the listener.
const prepareForShutdown = () => {
  if (quiescing) return
  quiescing = true
  acceptingDiarizationJobs = false
  for (const response of activeHttpResponses) {
    if (!response.headersSent) response.setHeader('connection', 'close')
  }
  logger.info('gateway.quiescing', { role: processRole, activeRequests: activeHttpRequests })
}
const stopServer = () => {
  if (draining) return
  prepareForShutdown()
  draining = true
  if (activeHttpRequests === 0) httpDrained()
  acceptingDiarizationJobs = false
  httpServer?.close(() => undefined)
  // A rolling update should normally let the active durable job finish. If
  // Kubernetes force-terminates this process, its lease expires and another
  // Pod claims it; the generation fence prevents this Pod's stale result from
  // being committed after that handoff.
  const graceMs = Math.max(1_000, Number(process.env.S2T_SHUTDOWN_GRACE_MS || 25_000))
  logger.info('gateway.shutdown', { role: processRole, graceMs, activeJob: Boolean(activeDiarizationJob) })
  const finish = Promise.race([Promise.all([httpDrainedPromise, activeDiarizationJob || Promise.resolve()]), new Promise(resolve => setTimeout(resolve, graceMs))])
  void finish.finally(() => sherpaWorkerPool.close()).finally(() => sharedLimits.close()).finally(() => process.exit(0))
}
process.once('SIGTERM', stopServer)
process.once('SIGINT', stopServer)
process.on('SIGUSR2', prepareForShutdown)
