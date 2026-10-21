const { Agent, setGlobalDispatcher } = require('undici')
const { cachedLookup } = require('/app/server/dns-lookup.cjs')
setGlobalDispatcher(new Agent({ connections: 1024, connect: { lookup: cachedLookup } }))
const { createServer } = require('node:http')
const { Pool } = require('pg')
const jwt = require('jsonwebtoken')
const { randomUUID } = require('node:crypto')
const { monitorEventLoopDelay } = require('node:perf_hooks')
const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable()
const users = Number(process.env.S2T_PERF_USERS || 500), seconds = Number(process.env.S2T_PERF_SECONDS || 600), cadence = 2000
const base = 'http://gateway:8787', run = randomUUID().slice(0, 8)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const stats = () => ({ attempted: 0, errors: 0, over3s: 0, maxMs: 0, errorTypes: {}, durations: [], residuals: [], statuses: {} })
const all = { asr: stats(), translation: stats(), upload: stats(), draft: stats(), chain: stats() }, minutes = new Map(), failures = {}
const pending = new Set(), uploadTails = new Map()
let offered = 0, dropped = 0, maximumPending = 0, startedAt, originMonotonic, warmup, elapsed = 0, finished = false
const quantile = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)] : null
const compact = value => ({ attempted: value.attempted, errors: value.errors, statuses: value.statuses, errorTypes: value.errorTypes, successRate: value.attempted ? (value.attempted - value.errors) / value.attempted : null, over3s: value.over3s, over3sRate: value.attempted ? value.over3s / value.attempted : null, p50Ms: quantile(value.durations, .5), p90Ms: quantile(value.durations, .9), p95Ms: quantile(value.durations, .95), p99Ms: quantile(value.durations, .99), maxMs: value.attempted ? value.maxMs : null, residualP95Ms: quantile(value.residuals, .95) })
const minuteStats = () => { const index = Math.floor(originMonotonic === undefined ? 0 : (performance.now() - originMonotonic) / 60000); if (!minutes.has(index)) minutes.set(index, Object.fromEntries(Object.keys(all).map(key => [key, stats()]))); return minutes.get(index) }
const observe = (kind, duration, failed, status, residual) => {
  for (const value of [all[kind], minuteStats()[kind]]) {
    value.attempted++; if (failed) value.errors++
    value.durations.push(duration); value.maxMs = Math.max(value.maxMs, duration); if (duration >= 3000) value.over3s++
    if (failed) { const type = status ? `http_${status}` : 'transport_timeout_or_abort'; value.errorTypes[type] = (value.errorTypes[type] || 0) + 1 }
    if (status) value.statuses[status] = (value.statuses[status] || 0) + 1
    if (residual !== undefined) value.residuals.push(residual)
  }
}
const endpoint = createServer((request, response) => {
  if (request.url === '/raw-report') { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify({...report(), rawStages: all, rawMinutes: [...minutes]})) }
  if (request.url === '/report') { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify(report())) }
  if (request.url !== '/metrics') { response.statusCode = 404; return response.end() }
  const lines = [`s2t_perf_elapsed_seconds ${elapsed}`, `s2t_perf_offered_total ${offered}`, `s2t_perf_dropped_total ${dropped}`, `s2t_perf_pending ${pending.size}`, `s2t_perf_finished ${finished ? 1 : 0}`]
  for (const [kind, value] of Object.entries(all)) {
    lines.push(`s2t_perf_requests_total{kind="${kind}"} ${value.attempted}`, `s2t_perf_errors_total{kind="${kind}"} ${value.errors}`, `s2t_perf_over_3s_total{kind="${kind}"} ${value.over3s}`)
    for (const [status, count] of Object.entries(value.statuses)) lines.push(`s2t_perf_http_responses_total{kind="${kind}",status="${status}"} ${count}`)
    for (const [type, count] of Object.entries(value.errorTypes)) lines.push(`s2t_perf_failures_total{kind="${kind}",type="${type}"} ${count}`)
    for (const [p, label] of [[.5, '0.5'], [.9, '0.9'], [.95, '0.95'], [.99, '0.99']]) if (value.durations.length) lines.push(`s2t_perf_duration_milliseconds{kind="${kind}",quantile="${label}"} ${quantile(value.durations.slice(-15000), p)}`)
    if (value.residuals.length) lines.push(`s2t_perf_http_residual_milliseconds{kind="${kind}"} ${quantile(value.residuals.slice(-15000), .95)}`)
  }
  response.setHeader('content-type', 'text/plain'); response.end(lines.join('\n') + '\n')
})
const report = () => ({ run, startedAt, warmup, users, targetUsers: Number(process.env.S2T_PERF_TOTAL_USERS || 500), gatewayReplicas: Number(process.env.S2T_PERF_GATEWAY_REPLICAS || 1), durationSeconds: seconds, elapsedSeconds: elapsed, cadenceMs: cadence, modelMs: 500, offered, dropped, maximumPending, finished, generatorLoopP99Ms: loop.percentile(99) / 1e6, generatorLoopMaxMs: loop.max / 1e6, generatorCpu: process.cpuUsage(), successfulChains: all.chain.attempted - all.chain.errors, offeredSuccessRate: offered ? (all.chain.attempted - all.chain.errors) / offered : null, stages: Object.fromEntries(Object.entries(all).map(([key, value]) => [key, compact(value)])), minutes: [...minutes].map(([minute, value]) => ({ minute, stages: Object.fromEntries(Object.entries(value).map(([key, data]) => [key, compact(data)])) })), failures, note: 'Real K8s Gateway, PostgreSQL, Redis Sentinel and MinIO; Configured accounts send 2-second PCM chunks every 2 seconds. Model APIs fixed at 500ms. Includes recording chunk persistence and live drafts. HTTP residual excludes browser rendering, microphone/VAD, ingress and WAN.' })
process.on('SIGTERM', () => { console.log(JSON.stringify({event:'cancelled',...report()})); process.exit(0) })
const pcm = Buffer.alloc(64000)
for (let i = 0; i < 32000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * .07) * 2500), i * 2)
const audio = Buffer.alloc(64044); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(64000, 40); pcm.copy(audio, 44)
const request = async (kind, path, token, body, headers = {}) => {
  const began = performance.now(); let status, failed = false, residual
  try {
    const response = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(30000) })
    status = response.status
    const result = response.status === 204 ? {} : await response.json()
    if (response.ok && (kind === 'asr' || kind === 'translation') && (typeof result.text !== 'string' || !result.text.trim())) throw new Error(`Invalid ${kind} success payload`)
    const total = /(?:^|,)\s*total;dur=([\d.]+)/.exec(response.headers.get('server-timing') || '')
    if (total) residual = Math.max(0, performance.now() - began - Number(total[1]))
    if (!response.ok) throw new Error(`HTTP ${status}: ${result.error || 'failed'}`)
    return result
  } catch (error) { failed = true; const key = String(error.message + (error.cause?.code ? ` (${error.cause.code})` : '')).slice(0, 180); failures[key] = (failures[key] || 0) + 1; throw error }
  finally { observe(kind, performance.now() - began, failed, status, residual) }
}
const track = promise => { pending.add(promise); maximumPending = Math.max(maximumPending, pending.size); promise.finally(() => pending.delete(promise)).catch(() => {}) }
;(async () => {
  for (let i = 0; i < 180; i++) { if (await fetch(base + '/readyz').then(response => response.ok, () => false)) break; if (i === 179) throw new Error('Gateway not ready'); await delay(1000) }
  const accountPrefix = `perf-${run}-`
  const pool = new Pool({ host: 'postgres', database: 's2t', user: 's2t', password: process.env.PG_TEST_PASSWORD, max: 1, connectionTimeoutMillis: 3000, query_timeout: 5000 })
  await pool.query(`INSERT INTO s2t_users (id,username,password_hash,nt,department,role) SELECT $1 || n, $1 || n, 'benchmark-no-password-login', $1 || n, 'performance', 'user' FROM generate_series(0,$2) n ON CONFLICT (id) DO NOTHING`, [accountPrefix, users - 1])
  await pool.end()
  const tokens = Array.from({ length: users }, (_, i) => jwt.sign({ sub: `${accountPrefix}${i}`, jti: `${run}-${i}` }, process.env.PERF_AUTH_SECRET, { expiresIn: '2h' }))
  await new Promise(resolve => endpoint.listen(9095, '0.0.0.0', resolve))
  // Real users authenticate and load app configuration before starting audio.
  // Keep the cold-client diagnostic reports separately; record all preflight
  // responses explicitly rather than dropping slow caption observations.
  const plannedStart = Number(process.env.S2T_PERF_START_AT || Date.now())
  await delay(Math.max(0, plannedStart - 3000 - Date.now()))
  const warmBegan = performance.now(), warmDurations = []
  await Promise.all(tokens.flatMap(token => ['/api/auth/session', '/api/config'].map(async path => {
    const began = performance.now()
    const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })
    await response.arrayBuffer()
    if (!response.ok) throw new Error(`Preflight ${path} HTTP ${response.status}`)
    warmDurations.push(performance.now() - began)
  })))
  warmup = { requests: warmDurations.length, errors: 0, durationMs: performance.now() - warmBegan, p95Ms: quantile(warmDurations, .95), maxMs: Math.max(...warmDurations), scenario: 'Authenticated users loaded session and app configuration before simultaneous audio' }
  console.log(JSON.stringify({ event: 'preflight_completed', warmup }))
  if (process.env.S2T_PERF_START_AT) await delay(Math.max(0, plannedStart - Date.now()))
  startedAt = new Date().toISOString(); const origin = performance.now(); originMonotonic = origin; loop.reset()
  console.log(JSON.stringify({ event: 'started', startedAt, users, seconds, cadenceMs: cadence, run }))
  let nextReport = 30
  for (let tick = 0; tick * cadence < seconds * 1000; tick++) {
    const scheduled = origin + tick * cadence
    await delay(Math.max(0, scheduled - performance.now())); elapsed = (performance.now() - origin) / 1000
    for (let user = 0; user < users; user++) {
      offered++
      if (pending.size >= Math.max(100, users * 8)) { dropped++; continue }
      const token = tokens[user]
      const chain = (async () => {
        let failed = false
        try {
          const caption = await request('asr', '/api/transcriptions', token, audio, { 'content-type': 'audio/wav', 'x-s2t-idempotency-key': `${run}-${user}-${tick}-asr` })
          await request('translation', '/api/translations', token, JSON.stringify({ text: caption.text, sourceLanguage: 'en-US', targetLanguage: 'zh-TW' }), { 'content-type': 'application/json', 'x-s2t-idempotency-key': `${run}-${user}-${tick}-translation` })
        } catch { failed = true }
        observe('chain', performance.now() - scheduled, failed)
      })()
      track(chain)
      const prior = uploadTails.get(user) || Promise.resolve()
      const upload = prior.catch(() => {}).then(async () => {
        const began = performance.now(); let failed = false, status
        try {
          const response = await fetch(`${base}/api/data/recordings/${run}-${user}/chunks/${tick}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-s2t-start-sample': String(tick * 32000), 'x-s2t-sample-rate': '16000' }, body: pcm, signal: AbortSignal.timeout(30000) })
          status = response.status; const ack = await response.json()
          if (!response.ok || !ack.durable) throw new Error(`Recording HTTP ${status}: ${ack.error || 'not durable'}`)
        } catch (error) { failed = true; failures[error.message] = (failures[error.message] || 0) + 1 }
        finally { observe('upload', performance.now() - began, failed, status) }
      })
      uploadTails.set(user, upload); track(upload)
      if (tick % 5 === 0) track(request('draft', '/api/data/live-draft', token, JSON.stringify({ value: { id: `${run}-${user}`, createdAt: startedAt, segments: [{ id: `line-${tick}`, sourceText: 'Performance test live caption.', startMs: tick * 2000, endMs: tick * 2000 + 2000, status: 'final', revision: 1 }] } }), { 'content-type': 'application/json' }).catch(() => {}))
    }
    if (elapsed >= nextReport) { console.log(JSON.stringify({ event: 'progress', elapsedSeconds: Math.round(elapsed), offered, dropped, pending: pending.size, chain: compact(all.chain), upload: compact(all.upload), rssBytes: process.memoryUsage().rss })); nextReport += 30 }
  }
  await Promise.allSettled([...pending]); await delay(Math.max(0, origin + seconds * 1000 - performance.now())); elapsed = (performance.now() - origin) / 1000; finished = true
  console.log(JSON.stringify({ event: 'completed', startedAt, ...report() }))
  // Keep the completed report available to Prometheus/Grafana and kubectl exec.
  const failed = dropped || Object.values(all).some(value => value.errors) || quantile(all.asr.durations,.9) >= 3000 || quantile(all.chain.durations,.9) >= 3000
  console.log(JSON.stringify({ event: 'verdict', criterion: 'P90 ASR and ASR-to-translation <3s, no HTTP errors or dropped work', passed: !failed }))
})().catch(error => { console.error(error); process.exitCode = 1; endpoint.close() })
