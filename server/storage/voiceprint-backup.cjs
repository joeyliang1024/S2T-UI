const { safePart, validateVectorRecord } = require('./local.cjs')

const snapshotVoiceprints = async (storage, userId) => {
  const scope = safePart(userId, 'user id')
  const voiceprints = await storage.config.get(scope, 'voiceprints')
  const entries = Array.isArray(voiceprints) ? JSON.parse(JSON.stringify(voiceprints)) : []
  const ids = entries.map((entry) => entry?.id).filter((id) => typeof id === 'string')
  const vectors = await storage.vector.getMany(ids)
  if (vectors.length !== ids.length) throw new Error('聲紋備份不完整：metadata 與向量數量不一致')
  for (const vector of vectors) validateVectorRecord(vector)
  const metadata = typeof storage.config.listVoiceprints === 'function'
    ? await storage.config.listVoiceprints(scope)
    : entries.map((entry) => ({ vectorId: entry.id, userId: scope, embeddingModel: entry.embeddingModel, embeddingVersion: entry.embeddingVersion, sharingScope: entry.sharingScope || 'private', createdAt: entry.createdAt }))
  if (metadata.length !== ids.length) throw new Error('聲紋備份不完整：metadata 註冊資料不一致')
  return { version: 1, createdAt: new Date().toISOString(), userId: scope, voiceprints: entries, metadata, vectors }
}

const validateSnapshot = (snapshot) => {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.userId !== 'string' || !Array.isArray(snapshot.voiceprints) || !Array.isArray(snapshot.metadata) || !Array.isArray(snapshot.vectors)) throw new Error('無效的聲紋備份格式')
  const userId = safePart(snapshot.userId, 'user id')
  const ids = new Set(snapshot.voiceprints.map((entry) => entry?.id).filter((id) => typeof id === 'string'))
  if (ids.size !== snapshot.voiceprints.length || snapshot.vectors.length !== ids.size || snapshot.metadata.length !== ids.size) throw new Error('聲紋備份內容不完整')
  for (const vector of snapshot.vectors) { if (!ids.has(vector?.id)) throw new Error('聲紋備份含有未登錄向量'); validateVectorRecord(vector) }
  for (const record of snapshot.metadata) {
    if (!record || !ids.has(record.vectorId) || record.userId !== userId || typeof record.embeddingModel !== 'string' || typeof record.embeddingVersion !== 'string') throw new Error('聲紋備份 metadata 無效')
  }
  return { userId, ids }
}

const applySnapshot = async (storage, snapshot, previousIds) => {
  const { userId, ids } = validateSnapshot(snapshot)
  for (const vector of snapshot.vectors) await storage.vector.upsert(vector)
  if (typeof storage.config.replaceVoiceprints === 'function') await storage.config.replaceVoiceprints(userId, snapshot.metadata)
  await storage.config.put(userId, 'voiceprints', JSON.parse(JSON.stringify(snapshot.voiceprints)))
  await Promise.all([...previousIds].filter((id) => !ids.has(id)).map((id) => storage.vector.remove(id)))
}

const restoreVoiceprints = async (storage, snapshot) => {
  const { userId } = validateSnapshot(snapshot)
  const before = await snapshotVoiceprints(storage, userId)
  try {
    await applySnapshot(storage, snapshot, new Set(before.voiceprints.map((entry) => entry.id)))
  } catch (error) {
    try { await applySnapshot(storage, before, new Set(snapshot.voiceprints.map((entry) => entry.id))) } catch (rollbackError) {
      throw new Error(`聲紋還原失敗，且補償失敗：${rollbackError instanceof Error ? rollbackError.message : '未知錯誤'}`)
    }
    throw error
  }
}

module.exports = { snapshotVoiceprints, restoreVoiceprints }
