

export const readJsonResponse = async <T,>(response: Response, service: string): Promise<T> => {
  const body = await response.text()
  if (!body.trim()) throw new Error(`${service} 沒有回傳資料（HTTP ${response.status}）。請確認本機 gateway 是否已啟動。`)
  let payload: unknown
  try { payload = JSON.parse(body) } catch { throw new Error(`${service} 回傳非 JSON 資料（HTTP ${response.status}）。`) }
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `HTTP ${response.status}`
    throw new Error(`${service} 失敗：${error}`)
  }
  return payload as T
}
