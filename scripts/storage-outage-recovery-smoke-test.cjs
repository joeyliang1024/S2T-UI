const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { promisify } = require('node:util')
const dotenv = require('dotenv')
const { createStorage } = require('../server/storage/index.cjs')

dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })
const execFileAsync = promisify(execFile)
const base = process.env.S2T_COMPENSATION_SMOKE_BASE || 'http://127.0.0.1:8787'
const compose = ['--env-file', process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', '-f', 'docker-compose.local-storage.yml']
const milvusCompose = [...compose, '--profile', 'milvus']
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, options)
  return { response, body: response.status === 204 ? null : await response.json().catch(() => null) }
}

const main = async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const username = `outage-${suffix.slice(0, 16)}`
  const storage = createStorage(process.env)
  const audioId = `outage-${suffix}`
  let userId = null
  let token = null
  let minioStopped = false
  let milvusStopped = false
  try {
    await storage.ready
    const registration = await request('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'outage-smoke-password', NT: `Outage ${suffix.slice(0, 16)}`, Department: 'Storage smoke' }) })
    assert.equal(registration.response.status, 201, registration.body?.error)
    userId = registration.body.user.id; token = registration.body.token
    const auth = { authorization: `Bearer ${token}` }
    let result = await request(`/api/data/audio/${audioId}`, { method: 'POST', headers: { ...auth, 'content-type': 'audio/wav' }, body: Buffer.from('outage recovery audio') })
    assert.equal(result.response.status, 201)

    await execFileAsync('docker-compose', [...compose, 'stop', 'minio'])
    minioStopped = true
    result = await request('/api/data/storage-retry', { method: 'POST', headers: auth })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body, { retried: true, audioPending: 1, voiceprintPending: 0 }, 'blob cleanup must remain pending while MinIO is unavailable')

    await execFileAsync('docker-compose', [...compose, 'up', '-d', 'minio'])
    minioStopped = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(500)
      result = await request('/api/data/storage-retry', { method: 'POST', headers: auth })
      if (result.response.ok && result.body?.audioPending === 0) break
      if (attempt === 19) assert.fail(`MinIO recovered but compensation remained pending: ${JSON.stringify(result.body)}`)
    }
    result = await request(`/api/data/audio/${audioId}`, { headers: auth })
    assert.equal(result.response.status, 404)

    const voiceprintId = `outage-vp-${suffix}`
    await storage.config.put(userId, 'voiceprints', [{ id: voiceprintId, createdAt: new Date().toISOString() }])
    await storage.config.put(userId, 'voiceprint-compensations', [{ id: voiceprintId, type: 'delete', createdAt: new Date().toISOString() }])
    await execFileAsync('docker-compose', [...milvusCompose, 'stop', 'milvus'])
    milvusStopped = true
    result = await request('/api/data/storage-retry', { method: 'POST', headers: auth })
    assert.equal(result.response.status, 200)
    assert.deepEqual(result.body, { retried: true, audioPending: 0, voiceprintPending: 1 }, 'voiceprint cleanup must remain pending while Milvus is unavailable')
    await execFileAsync('docker-compose', [...milvusCompose, 'up', '-d', 'milvus'])
    milvusStopped = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(1_000)
      result = await request('/api/data/storage-retry', { method: 'POST', headers: auth })
      if (result.response.ok && result.body?.voiceprintPending === 0) break
      if (attempt === 29) assert.fail(`Milvus recovered but compensation remained pending: ${JSON.stringify(result.body)}`)
    }
    assert.deepEqual(await storage.config.get(userId, 'voiceprints'), [])
    console.log('Storage outage recovery smoke test passed.')
  } finally {
    if (minioStopped) await execFileAsync('docker-compose', [...compose, 'up', '-d', 'minio']).catch(() => undefined)
    if (milvusStopped) await execFileAsync('docker-compose', [...milvusCompose, 'up', '-d', 'milvus']).catch(() => undefined)
    if (userId) {
      await Promise.allSettled([storage.blob.remove(userId, `audio/${audioId}`), storage.config.remove(userId, 'audio-compensations'), storage.config.remove(userId, 'voiceprints'), storage.config.remove(userId, 'voiceprint-compensations')])
      await storage.config.pool?.query('DELETE FROM s2t_config_records WHERE scope = $1', [userId]).catch(() => undefined)
      await storage.config.pool?.query('DELETE FROM s2t_users WHERE id = $1', [userId]).catch(() => undefined)
    }
    await storage.config.pool?.end()
    await storage.vector.client?.closeConnection?.()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
