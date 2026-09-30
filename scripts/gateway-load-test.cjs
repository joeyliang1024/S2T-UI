#!/usr/bin/env node
// Reproducible gateway capacity probe. It deliberately reports all attempts,
// not only successful requests, and never fabricates a pod recommendation.
const { readFile } = require('node:fs/promises')

const base = (process.env.S2T_LOAD_BASE_URL || '').replace(/\/$/, '')
const token = process.env.S2T_LOAD_TOKEN || ''
const wavPath = process.env.S2T_LOAD_WAV || ''
const concurrency = Number.parseInt(process.env.S2T_LOAD_CONCURRENCY || '1', 10)
const durationSeconds = Number.parseInt(process.env.S2T_LOAD_DURATION_SECONDS || '60', 10)
const intervalMs = Number.parseInt(process.env.S2T_LOAD_INTERVAL_MS || '1000', 10)
const translationText = process.env.S2T_LOAD_TRANSLATION_TEXT || 'Load test caption.'
if (!base || !token || !wavPath || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100 || !Number.isInteger(durationSeconds) || durationSeconds < 1 || !Number.isInteger(intervalMs) || intervalMs < 100) throw new Error('需要 S2T_LOAD_BASE_URL、S2T_LOAD_TOKEN、S2T_LOAD_WAV；concurrency 1..100、duration > 0、interval >= 100')

const percentile = (values, value) => {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))]
}
const stats = () => ({ all: [], successful: [], errors: 0, timeouts: 0 })
const request = async (path, options, metric) => {
  const started = performance.now()
  try {
    const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(30_000) })
    const elapsed = performance.now() - started
    metric.all.push(elapsed)
    if (response.ok) metric.successful.push(elapsed); else metric.errors += 1
  } catch (error) {
    metric.all.push(performance.now() - started); metric.errors += 1
    if (error?.name === 'TimeoutError') metric.timeouts += 1
  }
}
const compact = (metric) => ({ attempts: metric.all.length, successful: metric.successful.length, errors: metric.errors, timeouts: metric.timeouts, p50Ms: percentile(metric.all, .5), p95Ms: percentile(metric.all, .95), p99Ms: percentile(metric.all, .99) })

;(async () => {
  const wav = await readFile(wavPath)
  const asr = stats(); const translation = stats(); const stopAt = Date.now() + durationSeconds * 1_000
  const headers = { authorization: `Bearer ${token}` }
  const worker = async () => {
    while (Date.now() < stopAt) {
      const started = Date.now()
      await request('/api/transcriptions', { method: 'POST', headers: { ...headers, 'content-type': 'audio/wav' }, body: wav }, asr)
      await request('/api/translations', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: translationText, sourceLanguage: 'en-US', targetLanguage: 'zh-TW' }) }, translation)
      const wait = intervalMs - (Date.now() - started)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  console.log(JSON.stringify({ startedAt: new Date(stopAt - durationSeconds * 1_000).toISOString(), durationSeconds, concurrency, intervalMs, asr: compact(asr), translation: compact(translation) }, null, 2))
})().catch((error) => { console.error(error); process.exitCode = 1 })
