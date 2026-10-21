const createTranslationRoutes = ({ translation, accountModelService, acceptsRequest, rateLimitResponse, readBody, send, storage, validateAdminParameters, executeIdempotent, requestHash, translationService, upstreamRateLimit, serverTimingHeader, logger, now = () => performance.now() }) => async (request, response, auth) => {
  if (request.method !== 'POST' || request.url !== '/api/translations') return false
  const handlerStartedAt = request.s2tStartedAt ?? now()
  // t6/t7 split source: queue + model travel to the browser via Server-Timing.
  // Only stages that ran are reported (an idempotent cache hit runs neither).
  const serverTiming = { total: 0 }
  const user = await auth.requireUser(request)
  const limit = await acceptsRequest(request, 'translations', user?.id)
  if (!limit.accepted) { rateLimitResponse(response, limit, 'Too many translation requests. Try again later.'); return true }
  if (!user) { send(response, 401, { error: '需要登入' }); return true }
  const profileId = String(request.headers['x-s2t-model-id'] || '')
  const selectedTranslation = profileId ? await accountModelService(auth, user, profileId, 'translation') : translation
  if (!selectedTranslation?.endpoint || !selectedTranslation.model || (!profileId && !selectedTranslation.apiKey)) { send(response, 503, { error: 'Web translation gateway has not been configured.' }); return true }
  try {
    const raw = await readBody(request, 256 * 1024)
    const rawInput = JSON.parse(raw.toString('utf8'))
    if (rawInput.temperature !== undefined && !['admin', 'developer'].includes(user.role)) { send(response, 403, { error: '只有 admin 或 developer 可調整翻譯參數' }); return true }
    let requestedTemperature
    try { requestedTemperature = rawInput.temperature === undefined ? undefined : validateAdminParameters({ translationTemperature: rawInput.temperature }).translationTemperature }
    catch (error) { send(response, 400, { error: error.message }); return true }
    const input = translationService.normalizeInput(rawInput)
    if (!input.text) { send(response, 400, { error: 'Text is required.' }); return true }
    translationService.logRequest({ profileId, input })
    const translationStartedAt = Date.now()
    const accountSettings = ['admin', 'developer'].includes(user.role) ? await storage.config.get(user.id, 'app-settings') : undefined
    const temperature = requestedTemperature ?? validateAdminParameters(accountSettings?.settings?.adminParameters)?.translationTemperature ?? 0.2
    const text = await executeIdempotent(
      storage.config,
      user.id,
      '/api/translations',
      request.headers['x-s2t-idempotency-key'],
      requestHash(JSON.stringify({ ...input, temperature, model: selectedTranslation.model, endpoint: selectedTranslation.endpoint, credential: requestHash(selectedTranslation.apiKey || '') })),
      async () => {
        const result = await translationService.translate({ selectedTranslation, user, profileId, input, temperature })
        serverTiming.model = result.modelMs
        serverTiming.queue = result.queueMs
        return result.text
      }
    )
    serverTiming.total = now() - handlerStartedAt
    logger.debug('translation.completed', { profileId, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, durationMs: Date.now() - translationStartedAt, chars: (text || '').length })
    response.setHeader('server-timing', serverTimingHeader(serverTiming))
    send(response, 200, { text })
  } catch (error) {
    const rateLimit = upstreamRateLimit(error)
    if (rateLimit) rateLimitResponse(response, rateLimit, 'Translation provider temporarily rate limited. Try again later.')
    else send(response, [400, 409, 503].includes(error?.status) ? error.status : 502, { error: error instanceof Error ? error.message : 'Translation request failed' })
  }
  return true
}

module.exports = { createTranslationRoutes }
