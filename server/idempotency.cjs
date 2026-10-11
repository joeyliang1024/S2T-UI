const { createHash, randomUUID } = require('node:crypto')
const error = (message, status) => Object.assign(new Error(message), { status })
const hash = value => createHash('sha256').update(value).digest('hex')

// Responses and leases live in the same adapter as account data. A process cache
// is never authoritative. Requests without an idempotency key retain old behavior.
const executeIdempotent = async (store, userId, route, key, fingerprint, operation) => {
  if (!key) return operation()
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(key)) throw error('無效的冪等識別', 400)
  const recordKey = `request-${hash(`${route}:${key}`)}`
  const owner = randomUUID()
  let cached
  let busy = false
  let conflict = false
  await store.update(userId, recordKey, value => {
    const now = Date.now()
    if (value && value.expiresAt > now) {
      if (value.fingerprint !== fingerprint) { conflict = true; return undefined }
      if (value.state === 'completed') { cached = value.result; return undefined }
      if (value.leaseUntil > now) { busy = true; return undefined }
    }
    return { fingerprint, owner, state: 'running', leaseUntil: now + 120000, expiresAt: now + 600000 }
  })
  if (conflict) throw error('同一冪等識別的請求內容不同', 409)
  if (cached !== undefined) return cached
  if (busy) throw error('相同請求正在處理，請稍後重試', 409)
  let lost = false
  let renewing = false
  const timer = setInterval(() => {
    if (renewing || lost) return
    renewing = true
    store.update(userId, recordKey, value => {
      if (value?.owner !== owner || value.state !== 'running' || value.leaseUntil <= Date.now()) { lost = true; return undefined }
      return { ...value, leaseUntil: Date.now() + 120000 }
    }).catch(() => { lost = true }).finally(() => { renewing = false })
  }, 30000)
  timer.unref()
  try {
    const result = await operation()
    let committed = false
    if (!lost) await store.update(userId, recordKey, value => {
      if (value?.owner !== owner || value.state !== 'running' || value.leaseUntil <= Date.now()) return undefined
      committed = true
      return { fingerprint, state: 'completed', result, expiresAt: Date.now() + 600000 }
    })
    if (!committed) throw error('處理租約失效，請重試', 503)
    return result
  } catch (failure) {
    await store.update(userId, recordKey, value => value?.owner === owner ? { ...value, leaseUntil: 0, expiresAt: 0 } : undefined).catch(() => undefined)
    throw failure
  } finally { clearInterval(timer) }
}
module.exports = { executeIdempotent, hash }
