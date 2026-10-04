const positiveLimit = (value, fallback) => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const requestLimits = (env = process.env) => ({
  transcriptions: positiveLimit(env.S2T_ASR_REQUESTS_PER_MINUTE, 180),
  translations: positiveLimit(env.S2T_TRANSLATION_REQUESTS_PER_MINUTE, 180),
  summaries: 12, diarizations: 8, audioUploads: 30, voiceprintUploads: 12
})

const createRequestLimiter = (limits, now = Date.now) => {
  const requests = new Map()
  let lastCleanup = now()
  return (identity, bucket) => {
    const time = now()
    if (time - lastCleanup >= 60_000) {
      for (const [key, stamps] of requests) {
        if (time - stamps[stamps.length - 1] >= 60_000) requests.delete(key)
      }
      lastCleanup = time
    }
    const key = `${identity}:${bucket}`
    const recent = (requests.get(key) || []).filter((stamp) => time - stamp < 60_000)
    if (recent.length >= (limits[bucket] ?? 30)) {
      return { accepted: false, retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (time - recent[0])) / 1000)) }
    }
    recent.push(time)
    requests.set(key, recent)
    return { accepted: true, retryAfterSeconds: 0 }
  }
}

const upstreamRateLimit = (error, now = Date.now()) => {
  if (Number(error?.status || error?.statusCode) !== 429) return null
  const headers = error.headers
  const header = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after']
  const seconds = Number(header)
  const dateDelay = typeof header === 'string' ? (Date.parse(header) - now) / 1000 : NaN
  const bodyDelay = Number(error?.error?.retryAfterSeconds)
  const delay = seconds > 0 ? seconds : dateDelay > 0 ? dateDelay : bodyDelay > 0 ? bodyDelay : 30
  return { retryAfterSeconds: Number.isFinite(delay) ? Math.max(1, Math.ceil(delay)) : 30 }
}

module.exports = { requestLimits, createRequestLimiter, upstreamRateLimit }
