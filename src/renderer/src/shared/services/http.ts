

export const readJsonResponse = async <T,>(response: Response, service: string): Promise<T> => {
  const body = await response.text()
  if (!body.trim()) throw new Error(`${service} 沒有回傳資料（HTTP ${response.status}）。請確認本機 gateway 是否已啟動。`)
  try { return JSON.parse(body) as T } catch { throw new Error(`${service} 回傳非 JSON 資料（HTTP ${response.status}）。`) }
}
