import { activeTranslate } from '../i18n'

export class HttpServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterSeconds?: number) {
    super(message)
    this.name = 'HttpServiceError'
  }
}

export const responseRetryAfterSeconds = (response: Response, payload?: unknown): number | undefined => {
  const header = response.headers.get('retry-after')
  const numeric = Number(header)
  const dateDelay = header ? (Date.parse(header) - Date.now()) / 1000 : NaN
  const bodyDelay = payload && typeof payload === 'object' ? Number((payload as { retryAfterSeconds?: unknown }).retryAfterSeconds) : NaN
  const value = numeric > 0 ? numeric : dateDelay > 0 ? dateDelay : bodyDelay > 0 ? bodyDelay : NaN
  return Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : undefined
}

export const readJsonResponse = async <T,>(response: Response, service: string): Promise<T> => {
  const body = await response.text()
  if (!body.trim()) throw new HttpServiceError(activeTranslate('svcHttpNoBody').replace('{service}', service).replace('{status}', String(response.status)), response.status, responseRetryAfterSeconds(response))
  let payload: unknown
  try { payload = JSON.parse(body) } catch { throw new HttpServiceError(activeTranslate('svcHttpNonJson').replace('{service}', service).replace('{status}', String(response.status)), response.status, responseRetryAfterSeconds(response)) }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `HTTP ${response.status}`
    throw new HttpServiceError(activeTranslate('svcHttpFailed').replace('{service}', service).replace('{error}', error), response.status, responseRetryAfterSeconds(response, payload))
  }
  return payload as T
}
