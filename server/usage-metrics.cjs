// Operational counters: Prometheus retains history; these are not a billing ledger.
const operations = new Set(['transcriptions', 'translations', 'summaries', 'diarizations'])
const requestOperations = new Set([...operations, 'telemetry/captions', 'config', 'storage', 'audio/object', 'data/sessions', 'data/settings', 'data/glossary', 'data/voiceprints', 'data/diarization-jobs', 'data/storage-status', 'data/storage-audit', 'data/storage-retry', 'data/model-registry', 'data/model-health', 'data/model-credentials/id', 'data/summary-templates', 'auth/session', 'auth/logout', 'admin/users', 'audio-processing/silero-vad', 'audio-processing/status', 'audio-processing/import-wav', 'other'])
const users = new Map()
const journeys = new Map()
const observeJourney = (userId, stage) => {
  if (!['L1', 'L2', 'L3'].includes(stage) || !users.has(userId) || userId === '__overflow__') return false
  const value = journeys.get(userId)
  if (!value) return false
  value[stage]++
  return true
}
const maxUsers = 10000
const entry = userId => {
  if (typeof userId !== 'string' || !userId) return null
  // Keep memory bounded without evicting/resetting previously exposed counters.
  const key = users.has(userId) || users.size < maxUsers ? userId : '__overflow__'
  if (!users.has(key)) users.set(key, new Map())
  return users.get(key)
}
const registerUser = user => {
  const account = entry(user?.id)
  if (account && !journeys.has(user.id) && users.has(user.id)) journeys.set(user.id, { L1: 0, L2: 0, L3: 0 })
  if (account && account.nt === undefined) {
    account.nt = typeof user.NT === 'string' && user.NT ? user.NT : '未提供 NT'
    account.department = typeof user.Department === 'string' && user.Department ? user.Department : '未提供部門'
  }
}
const metric = (userId, operation) => {
  if (!requestOperations.has(operation)) return null
  const account = entry(userId)
  if (!account) return null
  if (!account.has(operation)) account.set(operation, { requests: {}, duration: 0, executions: 0, audioBytes: 0, audioSeconds: 0, audioUnknown: 0, inputChars: 0, outputChars: 0, inputTokens: 0, outputTokens: 0, tokenMissing: 0 })
  return account.get(operation)
}
const observeRequest = (userId, operation, status, seconds, aborted = false) => {
  operation = operation.replace(/^audio\/.*/, 'audio/object').replace(/^data\/model-credentials\/[^/]+$/, 'data/model-credentials/id')
  if (!requestOperations.has(operation)) operation = 'other'
  const value = metric(userId, operation)
  if (!value) return
  const outcome = aborted ? 'aborted' : status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success'
  value.requests[outcome] = (value.requests[outcome] || 0) + 1
  if (Number.isFinite(seconds) && seconds >= 0) value.duration += seconds
}
const wavSeconds = audio => {
  if (!Buffer.isBuffer(audio) || audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null
  let byteRate = 0, dataBytes = 0, pcm = false
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > audio.length) return null
    const kind = audio.toString('ascii', offset, offset + 4)
    if (kind === 'fmt ' && size >= 16) { pcm = [1, 3].includes(audio.readUInt16LE(start)); byteRate = audio.readUInt32LE(start + 8) }
    if (kind === 'data') dataBytes += size
    offset = start + size + (size % 2)
  }
  return pcm && byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : null
}
const observeExecution = (userId, operation, { audio, input = '', output = '', usage } = {}) => {
  if (!operations.has(operation)) return
  const value = metric(userId, operation)
  if (!value) return
  value.executions++
  if (Buffer.isBuffer(audio)) {
    value.audioBytes += audio.length
    const seconds = wavSeconds(audio)
    if (seconds === null) value.audioUnknown++
    else value.audioSeconds += seconds
  }
  value.inputChars += Array.from(input).length
  value.outputChars += Array.from(output).length
  if (operation === 'translations' || operation === 'summaries') {
    if (Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) {
      value.inputTokens += usage.prompt_tokens; value.outputTokens += usage.completion_tokens
    } else value.tokenMissing++
  }
}
const fields = { duration: 'request_seconds', executions: 'model_executions', audioBytes: 'audio_bytes', audioSeconds: 'audio_seconds', audioUnknown: 'audio_duration_unknown', inputChars: 'input_characters', outputChars: 'output_characters', inputTokens: 'input_tokens', outputTokens: 'output_tokens', tokenMissing: 'token_usage_missing' }
const render = () => {
  const lines = ['# TYPE s2t_user_requests_total counter']
  for (const suffix of Object.values(fields)) lines.push(`# TYPE s2t_user_${suffix}_total counter`)
  for (const [userId, account] of users) for (const [operation, value] of account) {
    const labels = `user_id=${JSON.stringify(userId)},nt=${JSON.stringify(userId === '__overflow__' ? '其他帳號（超過監控上限）' : account.nt || '未提供 NT')},department=${JSON.stringify(userId === '__overflow__' ? '其他部門（超過監控上限）' : account.department || '未提供部門')},operation=${JSON.stringify(operation)}`
    for (const outcome of ['success', 'client_error', 'server_error', 'aborted']) lines.push(`s2t_user_requests_total{${labels},outcome="${outcome}"} ${value.requests[outcome] || 0}`)
    for (const [field, suffix] of Object.entries(fields)) lines.push(`s2t_user_${suffix}_total{${labels}} ${value[field]}`)
  }
  lines.push('# TYPE s2t_user_journey_events_total counter')
  for (const [userId, counts] of journeys) {
    const account = users.get(userId)
    for (const [stage, count] of Object.entries(counts)) lines.push(`s2t_user_journey_events_total{user_id=${JSON.stringify(userId)},nt=${JSON.stringify(account.nt || '未提供 NT')},department=${JSON.stringify(account.department || '未提供部門')},stage=${JSON.stringify(stage)}} ${count}`)
  }
  return lines.join('\n') + '\n'
}
module.exports = { observeJourney, registerUser, observeRequest, observeExecution, render, wavSeconds }
