const { Client: MinioClient } = require('minio')
const { Pool } = require('pg')
const { safePart, validateEmbedding, validateVectorRecord } = require('./local.cjs')

const minioOptions = (config) => {
  const endpoint = new URL(config.S2T_MINIO_ENDPOINT.includes('://') ? config.S2T_MINIO_ENDPOINT : `http://${config.S2T_MINIO_ENDPOINT}`)
  return { endPoint: endpoint.hostname, port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80, useSSL: endpoint.protocol === 'https:', accessKey: config.S2T_MINIO_ACCESS_KEY, secretKey: config.S2T_MINIO_SECRET_KEY }
}
class MinioBlobStore {
  constructor(config) { this.bucket = config.S2T_MINIO_BUCKET; this.client = new MinioClient(minioOptions(config)); this.ready = this.ensureBucket() }
  async ensureBucket() { if (!await this.client.bucketExists(this.bucket)) await this.client.makeBucket(this.bucket) }
  key(scope, key) { return `${safePart(scope, 'scope')}/${key.split('/').map((part) => safePart(part, 'blob key')).join('/')}` }
  async put(scope, key, bytes) { await this.ready; await this.client.putObject(this.bucket, this.key(scope, key), bytes) }
  async get(scope, key) { await this.ready; try { const stream = await this.client.getObject(this.bucket, this.key(scope, key)); const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) } catch (error) { if (error && error.code === 'NoSuchKey') return null; throw error } }
  async remove(scope, key) { await this.ready; await this.client.removeObject(this.bucket, this.key(scope, key)) }
  async list(scope, prefix = '') {
    await this.ready
    const root = `${safePart(scope, 'scope')}/`
    const searchPrefix = prefix ? this.key(scope, prefix) : root
    return new Promise((resolve, reject) => {
      const keys = []; const stream = this.client.listObjects(this.bucket, searchPrefix, true)
      stream.on('data', (item) => { if (typeof item.name === 'string' && item.name.startsWith(root)) keys.push(item.name.slice(root.length)) })
      stream.on('error', reject); stream.on('end', () => resolve(keys))
    })
  }
}
class PostgresConfigStore {
  constructor(config) {
    const maxConnections = Number.parseInt(config.S2T_POSTGRES_MAX_CONNECTIONS || '10', 10)
    this.pool = new Pool({
      host: config.S2T_POSTGRES_HOST, port: Number(config.S2T_POSTGRES_PORT), database: config.S2T_POSTGRES_DB_NAME, user: config.S2T_POSTGRES_USER, password: config.S2T_POSTGRES_PASSWORD,
      max: Number.isInteger(maxConnections) && maxConnections > 0 && maxConnections <= 100 ? maxConnections : 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    })
    this.schemaVersion = '001-core-storage'; this.ready = this.migrate()
  }
  async migrate() {
    // Multiple gateway processes can start at the same time during a deploy.
    // DDL such as ALTER TABLE / CREATE INDEX otherwise takes locks in a
    // different order and can deadlock. Hold the advisory lock on one pooled
    // connection for the complete migration sequence.
    const client = await this.pool.connect()
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('s2t_schema_migrations'))")
      await client.query(`
      CREATE TABLE IF NOT EXISTS s2t_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nt TEXT NOT NULL,
        department TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS s2t_config_records (
        scope TEXT NOT NULL,
        record_key TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(scope, record_key)
      );
      CREATE TABLE IF NOT EXISTS s2t_voiceprint_records (
        vector_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES s2t_users(id) ON DELETE CASCADE,
        embedding_model TEXT NOT NULL,
        embedding_version TEXT NOT NULL,
        sharing_scope TEXT NOT NULL DEFAULT 'private',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS s2t_glossaries (
        user_id TEXT PRIMARY KEY REFERENCES s2t_users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS s2t_schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS s2t_diarization_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES s2t_users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        audio_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, session_id, audio_key)
      );
      CREATE INDEX IF NOT EXISTS s2t_config_records_scope_index ON s2t_config_records(scope);
      CREATE INDEX IF NOT EXISTS s2t_voiceprint_records_user_index ON s2t_voiceprint_records(user_id);
      CREATE INDEX IF NOT EXISTS s2t_diarization_jobs_claim_index ON s2t_diarization_jobs(state, lease_until, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS s2t_users_nt_unique_index ON s2t_users (lower(nt));
      ALTER TABLE s2t_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE s2t_voiceprint_records ADD COLUMN IF NOT EXISTS sharing_scope TEXT NOT NULL DEFAULT 'private';
      ALTER TABLE s2t_diarization_jobs ADD COLUMN IF NOT EXISTS lease_generation INTEGER NOT NULL DEFAULT 0;
      INSERT INTO s2t_schema_migrations(version) VALUES ('001-core-storage') ON CONFLICT(version) DO NOTHING;
    `)
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('s2t_schema_migrations'))").catch(() => undefined)
      client.release()
    }
  }
  async get(scope, key) { await this.ready; const result = await this.pool.query('SELECT value FROM s2t_config_records WHERE scope = $1 AND record_key = $2', [safePart(scope, 'scope'), safePart(key, 'record key')]); return result.rows[0]?.value ?? null }
  async put(scope, key, value) { await this.ready; await this.pool.query('INSERT INTO s2t_config_records(scope, record_key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT(scope, record_key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [safePart(scope, 'scope'), safePart(key, 'record key'), JSON.stringify(value)]) }
  async compareAndSwap(scope, key, expectedVersion, value) {
    await this.ready
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('無效的資料版本')
    const cleanScope = safePart(scope, 'scope'); const cleanKey = safePart(key, 'record key')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query('SELECT value FROM s2t_config_records WHERE scope = $1 AND record_key = $2 FOR UPDATE', [cleanScope, cleanKey])
      const stored = current.rows[0]?.value
      const version = stored && !Array.isArray(stored) && Number.isSafeInteger(stored.version) ? stored.version : 0
      if (version !== expectedVersion) { await client.query('ROLLBACK'); return false }
      if (current.rowCount) await client.query('UPDATE s2t_config_records SET value = $3::jsonb, updated_at = NOW() WHERE scope = $1 AND record_key = $2', [cleanScope, cleanKey, JSON.stringify(value)])
      else await client.query('INSERT INTO s2t_config_records(scope, record_key, value) VALUES ($1, $2, $3::jsonb)', [cleanScope, cleanKey, JSON.stringify(value)])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  async remove(scope, key) { await this.ready; await this.pool.query('DELETE FROM s2t_config_records WHERE scope = $1 AND record_key = $2', [safePart(scope, 'scope'), safePart(key, 'record key')]) }
  // Atomic read-modify-write. The row is locked with FOR UPDATE so concurrent
  // writers queue up and each transform sees the previous writer's result; a
  // fresh row (no lock possible) can still lose the insert race, which is
  // retried on the unique violation.
  async update(scope, key, transform) {
    await this.ready
    const cleanScope = safePart(scope, 'scope'); const cleanKey = safePart(key, 'record key')
    const client = await this.pool.connect()
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await client.query('BEGIN')
          const current = await client.query('SELECT value FROM s2t_config_records WHERE scope = $1 AND record_key = $2 FOR UPDATE', [cleanScope, cleanKey])
          const stored = current.rows[0]?.value ?? null
          const outcome = await transform(stored)
          if (outcome === undefined) { await client.query('ROLLBACK'); return { changed: false, value: stored } }
          if (current.rowCount) await client.query('UPDATE s2t_config_records SET value = $3::jsonb, updated_at = NOW() WHERE scope = $1 AND record_key = $2', [cleanScope, cleanKey, JSON.stringify(outcome)])
          else await client.query('INSERT INTO s2t_config_records(scope, record_key, value) VALUES ($1, $2, $3::jsonb)', [cleanScope, cleanKey, JSON.stringify(outcome)])
          await client.query('COMMIT')
          return { changed: true, value: outcome }
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          if (error?.code !== '23505' || attempt === 2) throw error
        }
      }
      throw new Error('storage 資料更新衝突，請稍後重試')
    } finally { client.release() }
  }
  async enqueueDiarizationJob({ id, userId, sessionId, audioKey, payload }) {
    await this.ready
    const result = await this.pool.query(`INSERT INTO s2t_diarization_jobs(id, user_id, session_id, audio_key, payload)
      VALUES($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT(user_id, session_id, audio_key) DO UPDATE SET payload = EXCLUDED.payload, state = 'queued', lease_owner = NULL, lease_until = NULL, error = NULL, updated_at = NOW()
      RETURNING id, state, attempts, created_at AS "createdAt", updated_at AS "updatedAt"`, [safePart(id, 'job id'), safePart(userId, 'user id'), safePart(sessionId, 'session id'), safePart(audioKey, 'audio key'), JSON.stringify(payload)])
    return result.rows[0]
  }
  async getDiarizationJob(userId, id) { await this.ready; const result = await this.pool.query('SELECT id, state, attempts, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM s2t_diarization_jobs WHERE user_id = $1 AND id = $2', [safePart(userId, 'user id'), safePart(id, 'job id')]); return result.rows[0] ?? null }
  async removeDiarizationJob(userId, id) { await this.ready; await this.pool.query('DELETE FROM s2t_diarization_jobs WHERE user_id = $1 AND id = $2', [safePart(userId, 'user id'), safePart(id, 'job id')]) }
  async claimDiarizationJob(owner, id = null) {
    await this.ready
    const result = await this.pool.query(`WITH candidate AS (
      SELECT id FROM s2t_diarization_jobs
      WHERE ($2::text IS NULL OR id = $2) AND ((state = 'queued' AND (lease_until IS NULL OR lease_until < NOW())) OR (state = 'running' AND lease_until < NOW()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE s2t_diarization_jobs AS job SET state = 'running', attempts = attempts + 1, lease_generation = lease_generation + 1, lease_owner = $1, lease_until = NOW() + INTERVAL '5 minutes', updated_at = NOW()
      FROM candidate WHERE job.id = candidate.id
      RETURNING job.id, job.user_id AS "userId", job.session_id AS "sessionId", job.audio_key AS "audioKey", job.payload, job.attempts, job.lease_generation AS "leaseGeneration"`, [safePart(owner, 'job owner'), id ? safePart(id, 'job id') : null])
    return result.rows[0] ?? null
  }
  async stillOwnsDiarizationJob(id, owner, leaseGeneration) {
    await this.ready
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return false
    const result = await this.pool.query("SELECT 1 FROM s2t_diarization_jobs WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND lease_generation = $3 AND lease_until > NOW()", [safePart(id, 'job id'), safePart(owner, 'job owner'), leaseGeneration])
    return result.rowCount === 1
  }
  async finishDiarizationJob(id, owner, leaseGeneration, error = null) {
    await this.ready
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) throw new Error('無效的工作租約 generation')
    const retry = typeof error === 'string' && error.startsWith('retry:')
    const state = retry ? 'queued' : error ? 'failed' : 'completed'
    // A retried job re-enters the queue behind a growing lease_until so a job
    // that can never succeed (for example one whose session never appears)
    // cannot be re-claimed every two seconds and re-run paid inference forever.
    await this.pool.query(`UPDATE s2t_diarization_jobs SET state = $4, error = $5, lease_owner = NULL,
      lease_until = CASE WHEN $4 = 'queued' THEN NOW() + LEAST(60, GREATEST(5, attempts * 5)) * INTERVAL '1 second' ELSE NULL END,
      updated_at = NOW() WHERE id = $1 AND lease_owner = $2 AND lease_generation = $3`, [safePart(id, 'job id'), safePart(owner, 'job owner'), leaseGeneration, state, error ? String(error).replace(/^retry:/, '').slice(0, 1000) : null])
  }
  async list(scope, prefix = '') { await this.ready; const result = await this.pool.query('SELECT record_key AS key, value, updated_at AS "updatedAt" FROM s2t_config_records WHERE scope = $1 AND record_key LIKE $2 ORDER BY record_key', [safePart(scope, 'scope'), `${prefix ? safePart(prefix, 'prefix') : ''}%`]); return result.rows }
  async createVoiceprint({ vectorId, userId, embeddingModel, embeddingVersion, sharingScope = 'private' }) {
    await this.ready
    if (!['private', 'department', 'organization'].includes(sharingScope)) throw new Error('無效的聲紋共享範圍')
    await this.pool.query('INSERT INTO s2t_voiceprint_records(vector_id, user_id, embedding_model, embedding_version, sharing_scope) VALUES($1, $2, $3, $4, $5)', [safePart(vectorId, 'vector id'), safePart(userId, 'user id'), String(embeddingModel).slice(0, 512), String(embeddingVersion).slice(0, 128), sharingScope])
  }
  async upsertVoiceprint({ vectorId, userId, embeddingModel, embeddingVersion, sharingScope = 'private' }) {
    await this.ready
    if (!['private', 'department', 'organization'].includes(sharingScope)) throw new Error('無效的聲紋共享範圍')
    await this.pool.query(`INSERT INTO s2t_voiceprint_records(vector_id, user_id, embedding_model, embedding_version, sharing_scope)
      VALUES($1, $2, $3, $4, $5)
      ON CONFLICT(vector_id) DO UPDATE SET user_id = EXCLUDED.user_id, embedding_model = EXCLUDED.embedding_model, embedding_version = EXCLUDED.embedding_version, sharing_scope = EXCLUDED.sharing_scope`, [safePart(vectorId, 'vector id'), safePart(userId, 'user id'), String(embeddingModel).slice(0, 512), String(embeddingVersion).slice(0, 128), sharingScope])
  }
  async listVoiceprints(userId) {
    await this.ready
    const result = await this.pool.query('SELECT vector_id AS "vectorId", user_id AS "userId", embedding_model AS "embeddingModel", embedding_version AS "embeddingVersion", sharing_scope AS "sharingScope", created_at AS "createdAt" FROM s2t_voiceprint_records WHERE user_id = $1 ORDER BY vector_id', [safePart(userId, 'user id')])
    return result.rows
  }
  async replaceVoiceprints(userId, records) {
    await this.ready
    const ownerId = safePart(userId, 'user id')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // A backup restore replaces the complete metadata set for one account.
      // Serialize that destructive set replacement across gateway processes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('s2t_voiceprint_restore:' || $1))", [ownerId])
      await client.query('DELETE FROM s2t_voiceprint_records WHERE user_id = $1', [ownerId])
      for (const record of records) {
        const sharingScope = record?.sharingScope || 'private'
        if (!['private', 'department', 'organization'].includes(sharingScope)) throw new Error('無效的聲紋共享範圍')
        await client.query('INSERT INTO s2t_voiceprint_records(vector_id, user_id, embedding_model, embedding_version, sharing_scope) VALUES($1, $2, $3, $4, $5)', [safePart(record.vectorId, 'vector id'), ownerId, String(record.embeddingModel).slice(0, 512), String(record.embeddingVersion).slice(0, 128), sharingScope])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  }
  async findVisibleVoiceprintIds({ userId, department, embeddingModel, embeddingVersion }) {
    await this.ready
    const result = await this.pool.query(`SELECT v.vector_id FROM s2t_voiceprint_records v JOIN s2t_users owner ON owner.id = v.user_id WHERE v.embedding_model = $3 AND v.embedding_version = $4 AND (v.user_id = $1 OR v.sharing_scope = 'organization' OR (v.sharing_scope = 'department' AND owner.department = $2))`, [safePart(userId, 'user id'), String(department).slice(0, 256), String(embeddingModel).slice(0, 512), String(embeddingVersion).slice(0, 128)])
    return result.rows.map((row) => row.vector_id)
  }
  async removeVoiceprint(vectorId, userId) {
    await this.ready
    const result = await this.pool.query('DELETE FROM s2t_voiceprint_records WHERE vector_id = $1 AND user_id = $2', [safePart(vectorId, 'vector id'), safePart(userId, 'user id')])
    return result.rowCount === 1
  }
  async getGlossary(userId) {
    await this.ready
    const result = await this.pool.query('SELECT content, version, updated_at AS "updatedAt" FROM s2t_glossaries WHERE user_id = $1', [safePart(userId, 'user id')])
    return result.rows[0] ?? { content: '', version: 0, updatedAt: null }
  }
  async putGlossary(userId, content, expectedVersion) {
    await this.ready
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('無效的術語版本')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query('SELECT version FROM s2t_glossaries WHERE user_id = $1 FOR UPDATE', [safePart(userId, 'user id')])
      const version = current.rows[0]?.version ?? 0
      if (version !== expectedVersion) { await client.query('ROLLBACK'); return null }
      const result = current.rowCount
        ? await client.query('UPDATE s2t_glossaries SET content = $2, version = version + 1, updated_at = NOW() WHERE user_id = $1 RETURNING version, updated_at AS "updatedAt"', [safePart(userId, 'user id'), String(content).slice(0, 20_000)])
        : await client.query('INSERT INTO s2t_glossaries(user_id, content, version) VALUES($1, $2, 1) RETURNING version, updated_at AS "updatedAt"', [safePart(userId, 'user id'), String(content).slice(0, 20_000)])
      await client.query('COMMIT')
      return result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
}
class MilvusVectorStore {
  // Milvus' REST v2 API is used deliberately: the gateway must not require
  // the Milvus Node SDK (which uses a gRPC transport).
  constructor(config) {
    this.collection = config.S2T_MILVUS_COLLECTION
    this.database = config.S2T_MILVUS_DB_NAME
    const endpoint = config.S2T_MILVUS_ENDPOINT.includes('://') ? config.S2T_MILVUS_ENDPOINT : `http://${config.S2T_MILVUS_ENDPOINT}`
    this.endpoint = endpoint.replace(/\/+$/, '')
    this.token = config.S2T_MILVUS_TOKEN
    this.dimension = null
    this.initializing = null
    this.ready = Promise.resolve()
  }
  async request(path, body) {
    const response = await fetch(`${this.endpoint}/v2/vectordb/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ dbName: this.database, ...body }),
      signal: AbortSignal.timeout(30_000)
    })
    const payload = await response.json().catch(() => { throw new Error(`Milvus REST ${response.status}: invalid JSON response`) })
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'code')) throw new Error('Milvus REST: missing response code')
    if (!response.ok || Number(payload.code) !== 0) {
      this.dimension = null
      throw new Error(payload.message || payload.error || `Milvus REST ${response.status} code ${payload.code}`)
    }
    return payload.data ?? payload
  }
  async hasCollection() {
    const data = await this.request('collections/has', { collectionName: this.collection })
    return data === true || data?.value === true || data?.has === true
  }
  async ensureCollection(dimension) {
    await this.ready
    if (this.dimension && this.dimension !== dimension) throw new Error(`聲紋維度不一致：collection 為 ${this.dimension}，輸入為 ${dimension}`)
    if (this.dimension === dimension) return
    if (!this.initializing) this.initializing = this.initializeCollection(dimension).finally(() => { this.initializing = null })
    await this.initializing
    if (this.dimension !== dimension) throw new Error(`聲紋維度不一致：collection 為 ${this.dimension}，輸入為 ${dimension}`)
  }
  async initializeCollection(dimension) {
    const exists = await this.hasCollection()
    if (!exists) {
      try {
        await this.request('collections/create', { collectionName: this.collection, dimension, primaryFieldName: 'id', idType: 'VarChar', vectorFieldName: 'embedding', metricType: 'COSINE', autoId: false, enableDynamicField: true, params: { max_length: '256', consistencyLevel: 'Strong' } })
      } catch (error) {
        if (!await this.hasCollection()) throw error
      }
    }
    const description = await this.request('collections/describe', { collectionName: this.collection })
    const schema = description?.schema ?? description
    this.consistencyLevel = description?.consistencyLevel
    const fields = schema?.fields || []
    const id = fields.find((field) => field.name === 'id')
    const embedding = fields.find((field) => field.name === 'embedding')
    const parameter = (values, key) => Array.isArray(values) ? values.find((item) => String(item.key).toLowerCase() === key)?.value : values?.[key]
    const storedDimension = Number(description?.dimension ?? parameter(embedding?.params, 'dim') ?? parameter(embedding?.typeParams, 'dim') ?? parameter(embedding?.type_params, 'dim'))
    if ((fields.length && (!id || !embedding)) || !Number.isSafeInteger(storedDimension) || storedDimension <= 0) throw new Error('Milvus collection schema 與聲紋資料契約不相容')
    if (dimension !== undefined && storedDimension !== dimension) throw new Error(`聲紋維度不一致：collection 為 ${storedDimension}，輸入為 ${dimension}`)
    await this.request('collections/load', { collectionName: this.collection })
    const deadline = Date.now() + 30_000
    for (;;) {
      const state = await this.request('collections/get_load_state', { collectionName: this.collection })
      if (state.loadState === 'LoadStateLoaded' || state.loadState === 'Loaded') break
      if (Date.now() >= deadline) throw new Error('Milvus collection load timed out')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    this.dimension = storedDimension
  }
  async upsert(record) { validateVectorRecord(record); await this.ensureCollection(record.embedding.length); await this.request('entities/upsert', { collectionName: this.collection, data: [record] }) }
  async remove(id) { await this.ready; if (!await this.hasCollection()) return; await this.request('entities/delete', { collectionName: this.collection, filter: `id in ${JSON.stringify([safePart(id, 'vector id')])}` }) }
  async nearest(embedding, limit = 5, allowedIds = []) {
    validateEmbedding(embedding)
    const ids = allowedIds.map((id) => safePart(id, 'vector id'))
    if (!ids.length) return []
    await this.ensureCollection(embedding.length)
    const output = await this.request('entities/search', { collectionName: this.collection, annsField: 'embedding', data: [embedding], filter: `id in ${JSON.stringify(ids)}`, limit: Math.max(1, Math.min(50, limit)), outputFields: ['id', 'NT', 'Department'], searchParams: { metricType: 'COSINE' }, consistencyLevel: 'Strong' })
    return (output.results || output || []).map((item) => ({ id: String(item.id), NT: item.NT, Department: item.Department, score: Number(item.score ?? item.distance ?? 0) }))
  }
  async getMany(ids) {
    const permitted = [...new Set(ids.map((id) => safePart(id, 'vector id')))]
    if (!permitted.length) return []
    await this.ready
    if (!await this.hasCollection()) return []
    if (!this.dimension) await this.initializeCollection()
    const records = []
    // 2.5.3 query ignores request consistencyLevel and uses the collection's
    // default. Legacy Bounded collections cannot be altered using that REST
    // version. An exact single-ID filtered strong search avoids stale backups
    // without deleting/recreating the user's existing collection.
    if (this.consistencyLevel !== 'Strong') {
      const probe = Array(this.dimension).fill(0); probe[0] = 1
      for (const id of permitted) {
        const output = await this.request('entities/search', { collectionName: this.collection, annsField: 'embedding', data: [probe], filter: `id in ${JSON.stringify([id])}`, limit: 1, outputFields: ['id', 'NT', 'Department', 'embedding'], consistencyLevel: 'Strong' })
        records.push(...(output.results || output || []))
      }
    } else {
      for (let offset = 0; offset < permitted.length; offset += 500) {
        const batch = permitted.slice(offset, offset + 500)
        const output = await this.request('entities/query', { collectionName: this.collection, filter: `id in ${JSON.stringify(batch)}`, limit: batch.length, consistencyLevel: 'Strong', outputFields: ['id', 'NT', 'Department', 'embedding'] })
        records.push(...(output.data || output.results || output || []))
      }
    }
    return records.map((item) => ({ id: String(item.id), NT: String(item.NT), Department: String(item.Department), embedding: Array.from(item.embedding || [], Number) }))
  }
}

module.exports = { MinioBlobStore, PostgresConfigStore, MilvusVectorStore }
