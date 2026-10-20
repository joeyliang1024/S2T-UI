// Explicit, authenticated, non-persistent API tests. Never cache a manual result.
const { openaiHealth, modelProbeKind } = require('./model-health.cjs')
const purposes = new Set(['asr', 'translation', 'summary', 'diarization', 'embedding'])
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)
const localEndpoints = new Set(['s2t-local://diarization', '/api/diarizations', '/api/audio-processing/silero-vad'])
const validateDraft = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('模型測試資料無效'), { status: 400 })
  if (body.id !== undefined && !validId(body.id)) throw Object.assign(new Error('模型 ID 無效'), { status: 400 })
  if (body.endpoint === undefined) {
    if (!validId(body.id)) throw Object.assign(new Error('請指定要測試的模型'), { status: 400 })
    return null
  }
  if (!purposes.has(body.purpose) || typeof body.endpoint !== 'string' || !body.endpoint.trim() || body.endpoint.length > 2000 || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200 || (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 8192)) || (body.requiresApiKey !== undefined && typeof body.requiresApiKey !== 'boolean')) throw Object.assign(new Error('請填寫有效的服務網址、用途與模型名稱'), { status: 400 })
  const endpoint = body.endpoint.trim()
  if (!localEndpoints.has(endpoint) && !/^\/api\/(transcriptions|translations|summaries)$/.test(endpoint)) {
    let url
    try { url = new URL(endpoint) } catch { throw Object.assign(new Error('服務網址格式無效'), { status: 400 }) }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw Object.assign(new Error('服務網址必須使用 HTTP(S) 或 WebSocket，且不可內嵌帳密'), { status: 400 })
  }
  return { id: body.id || 'manual-draft', purpose: body.purpose, endpoint, model: body.model.trim(), requiresApiKey: body.requiresApiKey !== false }
}

const availableModels = async (user, deps) => {
  const registry = await deps.storage.config.get(user.id, 'model-registry')
  const checks = Array.isArray(registry?.models) ? [...registry.models] : []
  const add = model => { if (model.endpoint && model.model && !checks.some(item => item.id === model.id)) checks.push(model) }
  for (const profile of deps.configuredAsrProfiles) add({ id: profile.id === 'default' ? 'web-environment-asr' : `web-gateway-asr-${profile.id}`, endpoint: profile.endpoint, model: profile.model, purpose: 'asr', service: profile, publicEndpoint: '/api/transcriptions' })
  for (const [id, purpose, service, publicEndpoint] of [['web-environment-translation','translation',deps.translation,'/api/translations'],['managed-summary','summary',deps.summary,'/api/summaries']]) add({ id, purpose, endpoint: service.endpoint, model: service.model, service, publicEndpoint })
  for (const profile of deps.localDiarizationProfiles()) add({ ...profile, purpose: 'diarization' })
  add({ id:'managed-diarization', purpose:'diarization', endpoint:deps.diarization.endpoint || '/api/diarizations', model:deps.diarization.model || deps.localModelName(), service:deps.diarization })
  add({ id:'managed-silero-vad', purpose:'asr', endpoint:'/api/audio-processing/silero-vad', model:'silero-vad' })
  return checks
}

const testModelApi = async (body, { auth, user, ...deps }) => {
  const draft = validateDraft(body)
  const models = await availableModels({ ...user, id: auth.modelOwner ? await auth.modelOwner() : user.id }, deps)
  const saved = models.find(item => item.id === body.id)
  const model = draft || saved
  if (!model) throw Object.assign(new Error('找不到此帳號的模型，請確認模型設定已保存'), { status: 404 })
  const startedAt = performance.now()
  const kind = modelProbeKind(model)
  let health
  if (kind === 'silero') health = await deps.sileroHealth(model)
  else if (kind === 'sherpa') health = await deps.sherpaHealth(model)
  else {
    // Reuse a stored credential only for the same purpose and exact destination.
    // A draft with a changed host/path must provide its own key.
    const sameDestination = saved && (!draft || saved.purpose === draft.purpose && (saved.endpoint === draft.endpoint || saved.publicEndpoint === draft.endpoint))
    const stored = sameDestination ? saved.service || (draft && (body.apiKey?.trim() || !draft.requiresApiKey) ? { endpoint:saved.endpoint, model:saved.model, apiKey:'' } : await deps.accountModelService(auth, user, saved.id, saved.purpose)) : null
    const endpoint = stored?.endpoint || model.endpoint
    if (endpoint.startsWith('/')) throw Object.assign(new Error('此 Gateway 端點尚未對應到模型，請填寫上游服務網址'), { status: 400 })
    const requiresKey = draft ? draft.requiresApiKey : saved.service ? false : model.requiresApiKey !== false
    const apiKey = draft ? (requiresKey ? body.apiKey?.trim() || stored?.apiKey || '' : '') : stored?.apiKey || ''
    const service = !requiresKey || apiKey ? { endpoint, model:model.model, apiKey } : null
    health = await (deps.openaiHealth || openaiHealth)(model, service, { baseUrl:deps.baseUrl })
  }
  return { ...health, id:model.id, elapsedMs:Math.round(performance.now() - startedAt), testKind:kind === 'openai' ? 'model-list' : 'local-runtime' }
}

const handleModelApiTest = async (request, response, deps) => {
  const user = await deps.auth.requireUser(request)
  if (!user) return deps.send(response, 401, { error:'需要登入' })
  const limit = await deps.acceptsRequest(request, 'modelTests', user.id)
  if (!limit.accepted) return deps.rateLimitResponse(response, limit, 'Model test rate limited')
  try {
    const body = JSON.parse((await deps.readBody(request, 16384)).toString('utf8'))
    const result = await testModelApi(body, { ...deps, user })
    return deps.send(response, 200, { result })
  } catch (error) {
    // Detailed provider errors are redacted by the probe; never echo request data.
    return deps.send(response, error.status || 400, { error: error.status ? error.message : '模型 API 測試失敗，請檢查設定後重試' })
  }
}
module.exports = { testModelApi, handleModelApiTest, validateDraft }
