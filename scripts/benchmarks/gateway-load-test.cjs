#!/usr/bin/env node
// Open arrival model: slow responses never reduce the offered speech cadence.
const { readFile } = require('node:fs/promises')
const base = (process.env.S2T_LOAD_BASE_URL || '').replace(/\/$/, '')
const concurrency = Number(process.env.S2T_LOAD_CONCURRENCY || 1)
const durationSeconds = Number(process.env.S2T_LOAD_DURATION_SECONDS || 60)
const intervalMs = Number(process.env.S2T_LOAD_INTERVAL_MS || 1000)
const maxInflight = Number(process.env.S2T_LOAD_MAX_INFLIGHT || concurrency * 4)
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null
const stats = () => ({ durations: [], successes: 0, errors: 0, timeouts: 0, statuses: {} })
const compact = value => ({ attempts: value.durations.length, successful: value.successes, errors: value.errors, timeouts: value.timeouts, statuses: value.statuses, p50Ms: percentile(value.durations, .5), p95Ms: percentile(value.durations, .95), p99Ms: percentile(value.durations, .99) })
;(async () => {
  if (!base || !process.env.S2T_LOAD_WAV || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 1000 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(intervalMs) || intervalMs < 100 || !Number.isSafeInteger(maxInflight) || maxInflight < 1) throw new Error('Invalid load configuration: concurrency 1..1000, duration > 0, interval >= 100')
  let tokens = process.env.S2T_LOAD_TOKENS_FILE ? JSON.parse(await readFile(process.env.S2T_LOAD_TOKENS_FILE, 'utf8')) : [process.env.S2T_LOAD_TOKEN]
  if (!Array.isArray(tokens) || tokens.some(token => typeof token !== 'string' || !token)) throw new Error('Provide S2T_LOAD_TOKEN or a JSON token array in S2T_LOAD_TOKENS_FILE')
  if (process.env.S2T_LOAD_TOKENS_FILE && (tokens.length < concurrency || new Set(tokens.slice(0, concurrency)).size !== concurrency)) throw new Error('Multi-account test requires a distinct token per simulated user')
  const wav = await readFile(process.env.S2T_LOAD_WAV)
  const asr = stats(), translation = stats(), chain = stats()
  const pending = new Set()
  let offered = 0, dropped = 0, sequence = 0, schedulerLagMs = 0
  const runId = require('node:crypto').randomUUID()
  const startedAt = performance.now(), stopAt = startedAt + durationSeconds * 1000
  const request = async (path, headers, body, metric) => {
    const started = performance.now()
    try {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) })
      const result = await response.json()
      metric.statuses[response.status] = (metric.statuses[response.status] || 0) + 1
      if (!response.ok || typeof result.text !== 'string') throw new Error(`HTTP ${response.status} or invalid model output`)
      metric.successes += 1
      return result.text
    } catch (error) { metric.errors += 1; if (error.name === 'TimeoutError') metric.timeouts += 1; throw error }
    finally { metric.durations.push(performance.now() - started) }
  }
  const speech = async (user, tick, scheduled) => {
    const token = tokens[user % tokens.length]
    const common = { authorization: `Bearer ${token}` }
    try {
      const text = await request('/api/transcriptions', { ...common, 'content-type': 'audio/wav', 'x-s2t-idempotency-key': `${runId}-${user}-${tick}-asr` }, wav, asr)
      await request('/api/translations', { ...common, 'content-type': 'application/json', 'x-s2t-idempotency-key': `${runId}-${user}-${tick}-translation` }, JSON.stringify({ text: text || process.env.S2T_LOAD_TRANSLATION_TEXT || 'Load test caption.', sourceLanguage: 'en-US', targetLanguage: 'zh-TW' }), translation)
      chain.successes += 1
    } catch { chain.errors += 1 }
    finally { chain.durations.push(performance.now() - scheduled) }
  }
  // Stagger users rather than sending all 100 chunks at exactly the same instant.
  while (true) {
    const scheduled = startedAt + sequence * intervalMs / concurrency
    if (scheduled >= stopAt) break
    const wait = scheduled - performance.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    schedulerLagMs = Math.max(schedulerLagMs, performance.now() - scheduled)
    offered += 1
    if (pending.size >= maxInflight) dropped += 1
    else {
      const task = speech(sequence % concurrency, Math.floor(sequence / concurrency), scheduled)
      pending.add(task); task.finally(() => pending.delete(task))
    }
    sequence += 1
  }
  await Promise.all(pending)
  console.log(JSON.stringify({ startedAt: new Date().toISOString(), durationSeconds, concurrency, distinctTokens: new Set(tokens.slice(0, concurrency)).size, intervalMs, offered, dropped, schedulerLagMs, asr: compact(asr), translation: compact(translation), gatewayChain: compact(chain), note: 'Gateway chain includes scheduled arrival, ASR and translation. It excludes microphone/VAD and browser rendering; distinct tokens must belong to distinct accounts.' }, null, 2))
  if (dropped || chain.errors) process.exitCode = 1
})().catch(error => { console.error(error.message); process.exitCode = 1 })
