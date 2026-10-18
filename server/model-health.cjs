// Read-only availability probe; it does not run inference or return credentials.
const safeDetail = (value, apiKey) => {
  let text = typeof value === 'string' ? value : ''
  if (apiKey) text = text.split(apiKey).join('[redacted]')
  return text.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/[\r\n\t]+/g, ' ').slice(0, 320)
}

const openaiHealth = async (model, service, { baseUrl, fetch: fetchProbe = fetch, timeoutMs = 8_000 } = {}) => {
  const result = (state, reason) => ({ id: model.id, state, reason, checkedAt: Date.now() })
  if (!service) return result('unknown', model.requiresApiKey === false ? '模型設定不完整，請檢查服務網址與模型名稱' : '尚未保存可用 API key，請到模型設定保存金鑰')
  if (/^wss?:/i.test(service.endpoint)) return result('unknown', '此 WebSocket 模型不支援 HTTP 模型清單檢查，尚未確認連線與推論狀態')
  try {
    const probe = await fetchProbe(`${baseUrl(service.endpoint)}/models`, { headers: service.apiKey ? { authorization: `Bearer ${service.apiKey}` } : {}, signal: AbortSignal.timeout(timeoutMs) })
    // Consume the body under the same deadline, including error responses.
    const body = await probe.json().catch(error => {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error
      return null
    })
    if (!probe.ok) {
      const explanation = ({ 401: '認證失敗，請檢查 API key 是否正確或已過期', 403: '存取被拒，請檢查帳號與模型權限', 404: '服務未提供模型清單端點，請確認網址及 /models 支援；尚無法判定推論是否可用', 405: '服務不支援模型清單檢查，尚無法判定推論是否可用', 429: '服務限流或配額不足，請稍後重試並檢查配額' })[probe.status] || (probe.status >= 500 ? '模型服務發生錯誤，請檢查上游服務狀態' : '模型服務拒絕健康檢查')
      const detail = safeDetail(body?.error?.message ?? (typeof body?.error === 'string' ? body.error : body?.message), service.apiKey)
      return result([404, 405].includes(probe.status) ? 'degraded' : 'unhealthy', `HTTP ${probe.status}：${explanation}${detail ? `；${detail}` : ''}`)
    }
    if (!Array.isArray(body?.data)) return result('degraded', '服務可達，但 /models 回應格式無效，無法確認指定模型（此檢查不執行推論）')
    return body.data.some(item => item?.id === service.model)
      ? result('healthy', '服務與指定模型均可用（模型清單檢查，未執行推論）')
      : result('degraded', `服務可達，但模型清單找不到「${service.model}」，請檢查模型名稱或載入狀態`)
  } catch (error) {
    const code = error?.cause?.code ?? error?.code
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? `健康檢查逾時（${timeoutMs / 1000} 秒），請檢查服務負載與網路`
      : ({ ERR_INVALID_URL: '模型服務網址格式無效，請檢查模型設定', ECONNREFUSED: '連線被拒，請確認模型服務已啟動及連接埠正確', ECONNRESET: '服務中斷連線，請檢查模型服務或代理伺服器', ETIMEDOUT: '連線逾時，請檢查服務位址與網路', UND_ERR_CONNECT_TIMEOUT: '連線逾時，請檢查服務位址與網路', ENOTFOUND: '找不到服務主機，請檢查網址與 DNS', EAI_AGAIN: 'DNS 暫時無法解析，請檢查網路後重試', CERT_HAS_EXPIRED: '服務 TLS 憑證已過期', DEPTH_ZERO_SELF_SIGNED_CERT: '服務 TLS 憑證不受信任' })[code] || `無法連線至模型服務：${safeDetail([error?.message, code, error?.cause?.message].filter(Boolean).join('；'), service.apiKey) || '未知連線錯誤'}`
    return result('unhealthy', reason)
  }
}

// The endpoint contract determines the local runtime, never a display name or
// localhost hostname (which can host an ordinary OpenAI-compatible service).
const modelProbeKind = model => model.endpoint === '/api/audio-processing/silero-vad' ? 'silero'
  : ['s2t-local://diarization', '/api/diarizations'].includes(model.endpoint) ? 'sherpa' : 'openai'
module.exports = { openaiHealth, modelProbeKind }
