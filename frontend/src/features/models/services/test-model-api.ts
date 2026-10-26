import { authFetch } from '../../../shared/http/authenticated-client'
export type ModelTestInput = { id?: string; purpose?: 'asr' | 'translation' | 'summary' | 'diarization' | 'embedding'; endpoint?: string; model?: string; requiresApiKey?: boolean; apiKey?: string }
export type ModelTestResult = { id: string; state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; reason: string; checkedAt: number; elapsedMs: number; testKind: 'model-list' | 'local-runtime' }
export const testModelApi = async (input: ModelTestInput, signal: AbortSignal): Promise<ModelTestResult> => {
  const response = await authFetch('/api/data/model-test', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input), signal })
  const payload = await response.json() as { result?: ModelTestResult; error?: string }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  if (!payload.result || !['healthy','degraded','unhealthy','unknown'].includes(payload.result.state)) throw new Error('Invalid API test response')
  return payload.result
}
