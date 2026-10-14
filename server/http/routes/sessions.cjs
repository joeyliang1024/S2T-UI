const { loadSessionSnapshot } = require('../../session-snapshot.cjs')

const createSessionRoutes = ({ storage, readSessionPayload, withSessionWrite, canonicalSessions, audioKeysInSessions, updateAudioCompensations, reconcileAudioCompensations, storageFailure, send }) => async (request, response, auth) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path !== '/api/data/sessions' || !['GET', 'POST'].includes(request.method)) return false
  await (async () => {
    const user = await auth.requireUser(request)
    if (!user) return send(response, 401, { error: '需要登入' })
    try {
      if (request.method === 'GET') {
        return send(response, 200, await loadSessionSnapshot(storage.config, user.id))
      }
      return await withSessionWrite(async () => {
      if (request.destroyed) throw Object.assign(new Error('紀錄同步傳輸中斷'), { status: 400 })
      const body = await readSessionPayload(request)
      if (!body || typeof body !== 'object' || !Array.isArray(body.sessions) || !Number.isSafeInteger(body.version) || body.version < 0) return send(response, 400, { error: 'sessions 與 version 必須有效' })
      const stored = await loadSessionSnapshot(storage.config, user.id)
      const previousSessions = Array.isArray(stored?.sessions) ? stored.sessions : Array.isArray(stored) ? stored : []
      const sessions = canonicalSessions(body.sessions)
      const previousAudioKeys = audioKeysInSessions(previousSessions)
      const nextAudioKeys = audioKeysInSessions(sessions)
      const removedAudioKeys = [...previousAudioKeys].filter((key) => !nextAudioKeys.has(key))
      // Save cleanup intent before CAS. A lost CAS keeps the old reference so
      // reconciliation retains it; a successful CAS makes cleanup durable.
      if (removedAudioKeys.length) {
        const removed = new Set(removedAudioKeys)
        await updateAudioCompensations(user, (entries) => {
          const known = new Set(entries.map((item) => item.id))
          const cleanup = [...removed].filter((id) => !known.has(id)).map((id) => ({ id, createdAt: new Date().toISOString() }))
          return cleanup.length ? [...entries, ...cleanup] : undefined
        })
      }
      const version = body.version + 1
      if (!await storage.config.compareAndSwap(user.id, 'sessions', body.version, { sessions, version })) {
        return send(response, 409, { error: '遠端記錄已有更新；請重新載入後再同步。' })
      }
      await reconcileAudioCompensations(user, sessions).catch(() => undefined)
      return send(response, 200, { saved: true, version })
      })
    } catch (error) {
      // Finish the structured error before closing an unread/oversized body.
      if (!request.complete) { response.setHeader('connection', 'close'); response.once('finish', () => request.destroy()) }
      if (error?.status === 503) response.setHeader('retry-after', '1')
      return storageFailure(response, error, '無法保存紀錄')
    }
  })()
  return true
}
module.exports = { createSessionRoutes }
