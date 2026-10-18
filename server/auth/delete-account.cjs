const { createHash } = require('node:crypto')
const bootstrapRetirementKey = username => 'retired-bootstrap-' + createHash('sha256').update(username.trim().toLowerCase()).digest('hex').slice(0, 40)
// Cross-store deletion is retryable: identity remains disabled until every
// owned object and vector is removed. The journal survives config cleanup.
const journalScope = 'account-deletions'
const createAccountDeletionService = ({ storage, users, bootstrapUsername }) => async (userId, actorId) => {
  if (userId === actorId) throw Object.assign(new Error('不能刪除目前登入的帳號'), { status: 409 })
  await users.markDeleting(userId, actorId)
  return storage.withAccountDeletion(userId, async () => {
    const account = await users.findById(userId)
    const previous = await storage.config.get(journalScope, userId)
    if (!account && !previous) return { deleted: true }
    const records = await storage.config.get(userId, 'voiceprints')
    const compensations = await storage.config.get(userId, 'voiceprint-compensations')
    const metadata = typeof storage.config.listVoiceprints === 'function' ? await storage.config.listVoiceprints(userId) : []
    const ids = new Set(Array.isArray(previous?.vectorIds) ? previous.vectorIds : [])
    for (const row of [...(Array.isArray(records) ? records : []), ...(Array.isArray(compensations) ? compensations : []), ...metadata]) {
      const id = row?.vectorId || row?.id
      if (typeof id === 'string' && id) ids.add(id)
    }
    await storage.config.put(journalScope, userId, { vectorIds: [...ids] })
    if (account && bootstrapUsername && account.username === bootstrapUsername.trim().toLowerCase()) await storage.config.put('auth', bootstrapRetirementKey(bootstrapUsername), true)
    // Admission is closed and all requests/jobs for this account have drained.
    for (const key of await storage.blob.list(userId)) await storage.blob.remove(userId, key)
    for (const id of ids) await storage.vector.remove(id)
    await storage.config.purgeAccount(userId)
    await users.remove(userId)
    await storage.config.remove(journalScope, userId)
    return { deleted: true }
  })
}
module.exports = { createAccountDeletionService, bootstrapRetirementKey }
