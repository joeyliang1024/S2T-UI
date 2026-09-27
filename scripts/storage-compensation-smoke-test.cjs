const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const dotenv = require('dotenv')
const { createStorage } = require('../server/storage/index.cjs')

dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })
const base = process.env.S2T_COMPENSATION_SMOKE_BASE || 'http://127.0.0.1:8787'

const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, options)
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  return { response, body }
}

const main = async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const username = `comp-${suffix.slice(0, 16)}`
  const NT = `Comp ${suffix.slice(0, 16)}`
  const storage = createStorage(process.env)
  let userId = null
  let token = null
  const orphanId = `orphan-${suffix}`
  const legacyOrphanId = `legacy-orphan-${suffix}`
  const committedId = `committed-${suffix}`
  try {
    await storage.ready
    const registered = await request('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'compensation-smoke-password', NT, Department: 'Storage smoke' }) })
    assert.equal(registered.response.status, 201, registered.body?.error)
    userId = registered.body.user.id
    token = registered.body.token
    const auth = { authorization: `Bearer ${token}` }

    let result = await request(`/api/data/audio/${orphanId}`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/wav' }, body: Buffer.from('orphan audio') })
    assert.equal(result.response.status, 201)
    result = await request('/api/data/storage-status', { headers: auth })
    assert.deepEqual(result.body, { audioPending: 1, voiceprintPending: 0 })
    result = await request('/api/data/storage-retry', { method: 'POST', headers: auth })
    assert.deepEqual(result.body, { retried: true, audioPending: 0, voiceprintPending: 0 })
    result = await request(`/api/data/audio/${orphanId}`, { headers: auth })
    assert.equal(result.response.status, 404)

    result = await request(`/api/data/audio/${legacyOrphanId}`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/wav' }, body: Buffer.from('legacy orphan audio') })
    assert.equal(result.response.status, 201)
    // Simulate a blob left by a pre-compensation version of the app. Pending
    // uploads are protected by the audit, so clear this marker deliberately.
    await storage.config.put(userId, 'audio-compensations', [])
    result = await request('/api/data/storage-audit', { headers: auth })
    assert.deepEqual(result.body, { orphanAudio: 1, deletedAudio: 0 })
    result = await request('/api/data/storage-audit', { method: 'POST', headers: auth })
    assert.deepEqual(result.body, { orphanAudio: 0, deletedAudio: 1 })
    result = await request(`/api/data/audio/${legacyOrphanId}`, { headers: auth })
    assert.equal(result.response.status, 404)

    const bytes = Buffer.from('committed audio')
    result = await request(`/api/data/audio/${committedId}`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/wav' }, body: bytes })
    assert.equal(result.response.status, 201)
    result = await request('/api/data/sessions', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ version: 0, sessions: [{ id: `session-${suffix}`, title: 'Compensation smoke', audioKey: committedId }] }) })
    assert.deepEqual(result.body, { saved: true, version: 1 })
    result = await request('/api/data/storage-status', { headers: auth })
    assert.deepEqual(result.body, { audioPending: 0, voiceprintPending: 0 })
    const audio = await fetch(`${base}/api/data/audio/${committedId}`, { headers: auth })
    assert.equal(audio.status, 200)
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), bytes)
    result = await request('/api/data/sessions', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, sessions: [] }) })
    assert.deepEqual(result.body, { saved: true, version: 2 })
    result = await request(`/api/data/audio/${committedId}`, { headers: auth })
    assert.equal(result.response.status, 404, 'removing a session must clean its committed remote audio')

    const voiceprintId = `missing-vp-${suffix}`
    await storage.config.put(userId, 'voiceprints', [{ id: voiceprintId, createdAt: new Date().toISOString() }])
    await storage.config.put(userId, 'voiceprint-compensations', [{ id: voiceprintId, type: 'delete', createdAt: new Date().toISOString() }])
    result = await request('/api/data/storage-retry', { method: 'POST', headers: auth })
    assert.deepEqual(result.body, { retried: true, audioPending: 0, voiceprintPending: 0 })
    assert.deepEqual(await storage.config.get(userId, 'voiceprints'), [])
    console.log('Storage compensation smoke test passed.')
  } finally {
    if (userId) {
      await Promise.allSettled([
        storage.blob.remove(userId, `audio/${orphanId}`),
        storage.blob.remove(userId, `audio/${legacyOrphanId}`),
        storage.blob.remove(userId, `audio/${committedId}`),
        storage.config.remove(userId, 'sessions'),
        storage.config.remove(userId, 'audio-compensations'),
        storage.config.remove(userId, 'voiceprints'),
        storage.config.remove(userId, 'voiceprint-compensations')
      ])
      await storage.config.pool?.query('DELETE FROM s2t_config_records WHERE scope = $1', [userId]).catch(() => undefined)
      await storage.config.pool?.query('DELETE FROM s2t_users WHERE id = $1', [userId]).catch(() => undefined)
    }
    await storage.config.pool?.end()
    await storage.vector.client?.closeConnection?.()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
