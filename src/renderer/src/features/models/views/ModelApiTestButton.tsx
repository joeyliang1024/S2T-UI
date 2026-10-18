import { useEffect, useRef, useState, type ReactElement } from 'react'
import { requestEpoch } from '../../../shared/http/authenticated-client'
import { testModelApi, type ModelTestInput, type ModelTestResult } from '../services/test-model-api'

type Props = { input: ModelTestInput; enabled?: boolean; ui: (key: string) => string; onResult?: (result: ModelTestResult) => void }
/** Isolated request state: editing or switching cards cannot show an old result. */
export function ModelApiTestButton({ input, enabled = true, ui, onResult }: Props): ReactElement {
  const [busy,setBusy] = useState(false)
  const [result,setResult] = useState<ModelTestResult | null>(null)
  const [error,setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const signature = JSON.stringify(input)
  useEffect(() => {
    generation.current++
    controller.current?.abort()
    controller.current = null
    setBusy(false);setResult(null);setError('')
    return () => { generation.current++;controller.current?.abort() }
  },[signature])
  const run = async (): Promise<void> => {
    if (!enabled || controller.current) return
    const request = ++generation.current, epoch = requestEpoch()
    const abort = new AbortController();controller.current = abort
    const timeout = window.setTimeout(() => abort.abort(),15000)
    setBusy(true);setResult(null);setError('')
    try {
      const health = await testModelApi(input,abort.signal)
      if (request !== generation.current || epoch !== requestEpoch()) return
      setResult(health);onResult?.(health)
    } catch (failure) {
      if (request !== generation.current || epoch !== requestEpoch()) return
      setError(abort.signal.aborted ? ui('modelApiTestTimeout') : failure instanceof Error ? failure.message : ui('modelApiTestFailed'))
    } finally {
      window.clearTimeout(timeout)
      if (request === generation.current) { controller.current = null;setBusy(false) }
    }
  }
  return <div className="model-api-test" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <button type="button" className="secondary model-api-test-button" disabled={!enabled || busy} onClick={() => void run()}>{ui(busy ? 'modelApiTesting' : 'modelApiTest')}</button>
    {result && <p className={`model-api-test-result ${result.state}`} role="status"><strong>{ui(result.state === 'healthy' ? 'modelHealthHealthy' : result.state === 'degraded' ? 'modelHealthDegraded' : result.state === 'unhealthy' ? 'modelHealthFailed' : 'modelHealthUnknown')} · {result.elapsedMs} ms</strong><span>{result.reason}</span></p>}
    {error && <p className="model-api-test-result unhealthy" role="alert">{error}</p>}
  </div>
}
