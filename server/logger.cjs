/**
 * Unified gateway logger. Every server module logs through this module so the
 * console carries one consistent shape instead of ad-hoc `console.log`.
 *
 *   logger.info('gateway.started', { port, role })
 *   logger.warn('storage.unavailable', { error })
 *   logger.error('asr.failed', { requestId, status, error })
 *   logger.debug('http.request', { method, path, status, durationMs })
 *
 * Default output is human-readable text:
 *
 *   2026-10-01T10:12:31.381+08:00 INFO  gateway.started port=8787 role=api
 *
 * `S2T_LOG_FORMAT=json` switches the whole process to one JSON object per
 * line so Kubernetes can index it later. `S2T_LOG_LEVEL` selects the level
 * (`debug` is off unless explicitly requested, so a production Pod is not
 * flooded by per-request lines).
 *
 * Every record carries the process role, the Pod name (HOSTNAME) and — when
 * the call happens inside an HTTP request — the shared requestId, so one ID
 * follows a request across ASR, translation, workers and storage.
 *
 * Credentials (Authorization, cookies, API keys, passwords, tokens) and raw
 * payloads (audio, transcripts, prompts) are redacted before anything is
 * written. Logging must never be the reason a secret reaches the console.
 */
const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')
const { hostname } = require('node:os')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

// Credentials: redacted whatever the surrounding object looks like.
const SENSITIVE_KEY = /(authorization|cookie|api[-_]?key|password|passwd|passphrase|secret|credential|token|private[-_]?key|jwt)/i
// Raw payloads that must never reach the console: audio, transcripts, prompts,
// embeddings. Length markers keep the log useful without printing the data.
// Deliberately does NOT include generic words such as `blob` or `vector`:
// those also appear as storage mode names (`mode.blob`) and would redact a
// harmless value. Binary values are caught by type instead of by key.
const PAYLOAD_KEY = /^(audio|audiodata|wav|pcm|transcript|transcripts|segments|text|messages?|prompt|completion|completions|embedding|embeddings|voiceprint)$/i

const MAX_FIELD_STRING = 512
const MAX_DEPTH = 3
const MAX_ARRAY_ITEMS = 20
const MAX_OBJECT_KEYS = 40

const context = new AsyncLocalStorage()

// Re-read on every emit so values loaded by dotenv after this module was
// required are honoured, without paying a parse cost per record.
let cachedKey = null
let cachedSettings = { threshold: LEVELS.info, format: 'text' }
const settings = () => {
  const level = String(process.env.S2T_LOG_LEVEL || 'info').trim().toLowerCase()
  const format = String(process.env.S2T_LOG_FORMAT || 'text').trim().toLowerCase()
  const key = `${level}|${format}`
  if (key !== cachedKey) {
    cachedKey = key
    cachedSettings = {
      threshold: Object.prototype.hasOwnProperty.call(LEVELS, level) ? LEVELS[level] : LEVELS.info,
      format: format === 'json' ? 'json' : 'text'
    }
  }
  return cachedSettings
}

const pad = (value, width = 2) => String(value).padStart(width, '0')
const timestamp = () => {
  const now = new Date()
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}

const baseFields = () => ({
  role: process.env.S2T_PROCESS_ROLE || 'all',
  pod: process.env.HOSTNAME || hostname()
})

const truncate = (value) => (value.length > MAX_FIELD_STRING
  ? `${value.slice(0, MAX_FIELD_STRING)}…[truncated ${value.length} chars]`
  : value)

const serializeError = (value) => {
  const error = value instanceof Error
    ? value
    : new Error(typeof value === 'string' && value ? value : safeJson(value) || String(value))
  const serialized = { name: error.name || 'Error', message: truncate(error.message || String(error)) }
  if (error.code !== undefined && error.code !== null) serialized.code = error.code
  if (typeof error.status === 'number') serialized.status = error.status
  else if (typeof error.statusCode === 'number') serialized.status = error.statusCode
  if (error.cause !== undefined && error.cause !== null) {
    serialized.cause = error.cause instanceof Error
      ? truncate(`${error.cause.name}: ${error.cause.message}`)
      : truncate(typeof error.cause === 'string' ? error.cause : safeJson(error.cause) || String(error.cause))
  }
  if (typeof error.stack === 'string' && error.stack) serialized.stack = error.stack
  return serialized
}

const jsonReplacer = () => {
  const seen = new WeakSet()
  return (_key, value) => {
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Error) return serializeError(value)
    if (typeof value === 'string') return truncate(value)
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  }
}

function safeJson (value) {
  try {
    const text = JSON.stringify(value, jsonReplacer())
    return text === undefined ? '' : text
  } catch { return '' }
}

const payloadMarker = (value) => {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[redacted bytes:${value.byteLength}]`
  if (typeof value === 'string') return `[redacted chars:${value.length}]`
  if (Array.isArray(value)) return `[redacted items:${value.length}]`
  return '[redacted]'
}

const normalize = (value, depth = 0) => {
  if (value === undefined || value === null) return null
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? value : String(value)
  if (type === 'boolean') return value
  if (type === 'bigint') return value.toString()
  if (type === 'string') return truncate(value)
  if (type === 'function' || type === 'symbol') return `[${type}]`
  if (value instanceof Error) return serializeError(value)
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[bytes:${value.byteLength}]`
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[array:${value.length}]` : '[object]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalize(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…+${value.length - MAX_ARRAY_ITEMS} more`)
    return items
  }
  if (value instanceof Map) return normalize(Object.fromEntries(value), depth)
  if (value instanceof Set) return normalize([...value], depth)
  if (type === 'object') {
    const entries = Object.entries(value)
    const out = {}
    for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) out[key] = sanitizeField(key, entry, depth + 1)
    if (entries.length > MAX_OBJECT_KEYS) out['…'] = `+${entries.length - MAX_OBJECT_KEYS} keys`
    return out
  }
  return String(value)
}

const sanitizeField = (key, value, depth = 0) => {
  if (value === undefined) return undefined
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (PAYLOAD_KEY.test(key)) return payloadMarker(value)
  if (value instanceof Error) return serializeError(value)
  return normalize(value, depth)
}

const sanitizeFields = (fields) => {
  if (!fields || typeof fields !== 'object') return {}
  if (fields instanceof Error) return { error: serializeError(fields) }
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    const sanitized = sanitizeField(key, value, 1)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

const escapeText = (value) => value
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')
  .replace(/\t/g, '\\t')

const renderValue = (value) => {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (value === '') return '""'
    return /[\s"=]/.test(value) ? `"${escapeText(value)}"` : value
  }
  // Objects and arrays are self-delimiting; JSON keeps them readable inline.
  return safeJson(value)
}

const isErrorRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && typeof value.message === 'string' && typeof value.stack === 'string' && typeof value.name === 'string'

const formatText = (ts, level, msg, fields) => {
  const pairs = []
  let stack = ''
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'error' && isErrorRecord(value)) {
      pairs.push(`error=${renderValue(truncate(`${value.name}: ${value.message}`))}`)
      if (typeof value.status === 'number') pairs.push(`status=${value.status}`)
      if (value.code !== undefined) pairs.push(`code=${renderValue(String(value.code))}`)
      stack = value.stack
      continue
    }
    pairs.push(`${key}=${renderValue(value)}`)
  }
  let line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`
  if (pairs.length) line += ` ${pairs.join(' ')}`
  if (stack) line += `\n${stack.split('\n').map((entry) => `    ${entry}`).join('\n')}`
  return line
}

const formatJson = (ts, level, msg, fields) => {
  const text = safeJson({ ts, level, msg, ...fields })
  return text || safeJson({ ts, level, msg, error: 'unserializable record' })
}

const write = (level, msg, fields, format) => {
  const ts = timestamp()
  const line = format === 'json' ? formatJson(ts, level, msg, fields) : formatText(ts, level, msg, fields)
  process.stdout.write(`${line}\n`)
}

const createLogger = (bindings = {}) => {
  const emit = (level, msg, fields) => {
    try {
      const current = settings()
      if (LEVELS[level] < current.threshold) return
      const store = context.getStore()
      const merged = {
        ...(store?.requestId ? { requestId: store.requestId } : {}),
        ...baseFields(),
        ...bindings,
        ...sanitizeFields(fields)
      }
      write(level, String(msg || 'log'), merged, current.format)
    } catch { /* A logging failure must never break a request. */ }
  }
  return {
    log: emit,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    enabled: (level) => Boolean(LEVELS[level]) && LEVELS[level] >= settings().threshold,
    level: () => settings().threshold,
    format: () => settings().format,
    child: (extra = {}) => createLogger({ ...bindings, ...extra }),
    // Runs `fn` with `bindings` (typically `{ requestId }`) attached to every
    // log record emitted inside it, including awaited continuations.
    run: (bindings2, fn) => context.run({ ...(context.getStore() || {}), ...bindings2 }, fn),
    store: () => context.getStore() || null,
    requestId: () => context.getStore()?.requestId || null
  }
}

const logger = createLogger()

module.exports = { logger, createLogger, newRequestId: () => randomUUID() }
