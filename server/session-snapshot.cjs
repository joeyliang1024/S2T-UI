const { randomInt } = require('node:crypto')
const validVersion = value => Number.isSafeInteger(value?.version) && value.version >= 0 && (value.version > 0 || sessionsOf(value)?.length === 0)
const sessionsOf = value => Array.isArray(value) ? value : value?.sessions
const corrupt = () => Object.assign(new Error('紀錄儲存格式無法辨識，請先還原備份；未覆寫既有資料'), { status: 503 })

const loadSessionSnapshot = async (store, userId) => {
  const stored = await store.get(userId, 'sessions')
  if (stored === null) return { sessions: [], version: 0 }
  if (!Array.isArray(sessionsOf(stored))) throw corrupt()
  if (validVersion(stored)) return stored
  // Repair under the same adapter lock used by writers. A stale version-zero
  // client must lose CAS after migration, rather than erase unseen history.
  // A fresh safe-integer epoch also fences older positive cached versions.
  const repaired = await store.update(userId, 'sessions', current => {
    if (current === null) return undefined
    if (!Array.isArray(sessionsOf(current))) throw corrupt()
    if (validVersion(current)) return undefined
    return { ...(Array.isArray(current) ? {} : current), sessions: sessionsOf(current), version: 2 ** 48 + randomInt(2 ** 48 - 1) }
  })
  return repaired.value === null ? { sessions: [], version: 0 } : repaired.value
}
module.exports = { loadSessionSnapshot }
