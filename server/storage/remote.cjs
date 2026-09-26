const { Client: MinioClient } = require('minio')
const { Pool } = require('pg')
const { MilvusClient, DataType } = require('@zilliz/milvus2-sdk-node')
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
}
class PostgresConfigStore {
  constructor(config) { this.pool = new Pool({ host: config.S2T_POSTGRES_HOST, port: Number(config.S2T_POSTGRES_PORT), database: config.S2T_POSTGRES_DB_NAME, user: config.S2T_POSTGRES_USER, password: config.S2T_POSTGRES_PASSWORD }); this.ready = this.migrate() }
  async migrate() {
    await this.pool.query(`
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
      CREATE INDEX IF NOT EXISTS s2t_config_records_scope_index ON s2t_config_records(scope);
      CREATE INDEX IF NOT EXISTS s2t_voiceprint_records_user_index ON s2t_voiceprint_records(user_id);
      ALTER TABLE s2t_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE s2t_voiceprint_records ADD COLUMN IF NOT EXISTS sharing_scope TEXT NOT NULL DEFAULT 'private';
    `)
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
  async list(scope, prefix = '') { await this.ready; const result = await this.pool.query('SELECT record_key AS key, value, updated_at AS "updatedAt" FROM s2t_config_records WHERE scope = $1 AND record_key LIKE $2 ORDER BY record_key', [safePart(scope, 'scope'), `${prefix ? safePart(prefix, 'prefix') : ''}%`]); return result.rows }
  async createVoiceprint({ vectorId, userId, embeddingModel, embeddingVersion, sharingScope = 'private' }) {
    await this.ready
    if (!['private', 'department', 'organization'].includes(sharingScope)) throw new Error('無效的聲紋共享範圍')
    await this.pool.query('INSERT INTO s2t_voiceprint_records(vector_id, user_id, embedding_model, embedding_version, sharing_scope) VALUES($1, $2, $3, $4, $5)', [safePart(vectorId, 'vector id'), safePart(userId, 'user id'), String(embeddingModel).slice(0, 512), String(embeddingVersion).slice(0, 128), sharingScope])
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
  constructor(config) { this.collection = config.S2T_MILVUS_COLLECTION; this.database = config.S2T_MILVUS_DB_NAME; this.client = new MilvusClient({ address: config.S2T_MILVUS_ENDPOINT, token: config.S2T_MILVUS_TOKEN, database: this.database }); this.dimension = null; this.initializing = null; this.ready = this.client.connectPromise }
  async ensureCollection(dimension) {
    await this.ready
    if (this.dimension && this.dimension !== dimension) throw new Error(`聲紋維度不一致：collection 為 ${this.dimension}，輸入為 ${dimension}`)
    if (!this.initializing) this.initializing = this.initializeCollection(dimension).finally(() => { this.initializing = null })
    await this.initializing
    if (this.dimension !== dimension) throw new Error(`聲紋維度不一致：collection 為 ${this.dimension}，輸入為 ${dimension}`)
  }
  async initializeCollection(dimension) {
    const exists = await this.client.hasCollection({ collection_name: this.collection, db_name: this.database })
    if (!exists.value) {
      try {
        await this.client.createCollection({ collection_name: this.collection, db_name: this.database, fields: [{ name: 'id', data_type: DataType.VarChar, max_length: 160, is_primary_key: true }, { name: 'NT', data_type: DataType.VarChar, max_length: 256 }, { name: 'Department', data_type: DataType.VarChar, max_length: 256 }, { name: 'embedding', data_type: DataType.FloatVector, dim: dimension }], index_params: [{ field_name: 'embedding', index_type: 'AUTOINDEX', metric_type: 'COSINE' }] })
      } catch (error) {
        const createdByAnotherProcess = await this.client.hasCollection({ collection_name: this.collection, db_name: this.database })
        if (!createdByAnotherProcess.value) throw error
      }
    }
    const description = await this.client.describeCollection({ collection_name: this.collection, db_name: this.database })
    const fields = description?.schema?.fields || []
    const id = fields.find((field) => field.name === 'id')
    const nt = fields.find((field) => field.name === 'NT')
    const department = fields.find((field) => field.name === 'Department')
    const embedding = fields.find((field) => field.name === 'embedding')
    const storedDimension = Number(embedding?.type_params?.find((parameter) => String(parameter.key).toLowerCase() === 'dim')?.value)
    if (!id?.is_primary_key || id.dataType !== DataType.VarChar || nt?.dataType !== DataType.VarChar || department?.dataType !== DataType.VarChar || embedding?.dataType !== DataType.FloatVector || !Number.isSafeInteger(storedDimension) || storedDimension <= 0) throw new Error('Milvus collection schema 與聲紋資料契約不相容')
    if (storedDimension !== dimension) throw new Error(`聲紋維度不一致：collection 為 ${storedDimension}，輸入為 ${dimension}`)
    this.dimension = storedDimension
    await this.client.loadCollectionSync({ collection_name: this.collection, db_name: this.database })
  }
  async upsert(record) { validateVectorRecord(record); await this.ensureCollection(record.embedding.length); await this.client.upsert({ collection_name: this.collection, db_name: this.database, data: [record] }) }
  async remove(id) { await this.ready; const exists = await this.client.hasCollection({ collection_name: this.collection, db_name: this.database }); if (!exists.value) return; await this.client.delete({ collection_name: this.collection, db_name: this.database, ids: [safePart(id, 'vector id')] }) }
  async nearest(embedding, limit = 5, allowedIds = []) {
    validateEmbedding(embedding)
    const ids = allowedIds.map((id) => safePart(id, 'vector id'))
    if (!ids.length) return []
    await this.ensureCollection(embedding.length)
    const output = await this.client.search({ collection_name: this.collection, db_name: this.database, data: [embedding], filter: `id in ${JSON.stringify(ids)}`, limit: Math.max(1, Math.min(50, limit)), output_fields: ['NT', 'Department'], metric_type: 'COSINE', consistency_level: 'Strong' })
    return (output.results || []).map((item) => ({ id: String(item.id), NT: item.NT, Department: item.Department, score: Number(item.score ?? item.distance ?? 0) }))
  }
}

module.exports = { MinioBlobStore, PostgresConfigStore, MilvusVectorStore }
