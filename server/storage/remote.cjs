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
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS s2t_config_records_scope_index ON s2t_config_records(scope);
      CREATE INDEX IF NOT EXISTS s2t_voiceprint_records_user_index ON s2t_voiceprint_records(user_id);
      ALTER TABLE s2t_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    `)
  }
  async get(scope, key) { await this.ready; const result = await this.pool.query('SELECT value FROM s2t_config_records WHERE scope = $1 AND record_key = $2', [safePart(scope, 'scope'), safePart(key, 'record key')]); return result.rows[0]?.value ?? null }
  async put(scope, key, value) { await this.ready; await this.pool.query('INSERT INTO s2t_config_records(scope, record_key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT(scope, record_key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [safePart(scope, 'scope'), safePart(key, 'record key'), JSON.stringify(value)]) }
  async remove(scope, key) { await this.ready; await this.pool.query('DELETE FROM s2t_config_records WHERE scope = $1 AND record_key = $2', [safePart(scope, 'scope'), safePart(key, 'record key')]) }
  async list(scope, prefix = '') { await this.ready; const result = await this.pool.query('SELECT record_key AS key, value, updated_at AS "updatedAt" FROM s2t_config_records WHERE scope = $1 AND record_key LIKE $2 ORDER BY record_key', [safePart(scope, 'scope'), `${prefix ? safePart(prefix, 'prefix') : ''}%`]); return result.rows }
}
class MilvusVectorStore {
  constructor(config) { this.collection = config.S2T_MILVUS_COLLECTION; this.database = config.S2T_MILVUS_DB_NAME; this.client = new MilvusClient({ address: config.S2T_MILVUS_ENDPOINT, token: config.S2T_MILVUS_TOKEN, database: this.database }); this.dimension = null; this.ready = this.client.connectPromise }
  async ensureCollection(dimension) {
    await this.ready; if (this.dimension && this.dimension !== dimension) throw new Error(`聲紋維度不一致：collection 為 ${this.dimension}，輸入為 ${dimension}`)
    const exists = await this.client.hasCollection({ collection_name: this.collection, db_name: this.database })
    if (!exists.value) await this.client.createCollection({ collection_name: this.collection, db_name: this.database, fields: [{ name: 'id', data_type: DataType.VarChar, max_length: 160, is_primary_key: true }, { name: 'NT', data_type: DataType.VarChar, max_length: 256 }, { name: 'Department', data_type: DataType.VarChar, max_length: 256 }, { name: 'embedding', data_type: DataType.FloatVector, dim: dimension }] })
    this.dimension = dimension; await this.client.loadCollectionSync({ collection_name: this.collection, db_name: this.database })
  }
  async upsert(record) { validateVectorRecord(record); await this.ensureCollection(record.embedding.length); await this.client.upsert({ collection_name: this.collection, db_name: this.database, data: [record] }) }
  async remove(id) { await this.ready; if (!this.dimension) return; await this.client.delete({ collection_name: this.collection, db_name: this.database, ids: [safePart(id, 'vector id')] }) }
  async nearest(embedding, limit = 5) { validateEmbedding(embedding); await this.ensureCollection(embedding.length); const output = await this.client.search({ collection_name: this.collection, db_name: this.database, data: [embedding], limit: Math.max(1, Math.min(50, limit)), output_fields: ['NT', 'Department'], metric_type: 'COSINE', consistency_level: 'Strong' }); return (output.results || []).map((item) => ({ id: String(item.id), NT: item.NT, Department: item.Department, score: Number(item.score ?? item.distance ?? 0) })) }
}

module.exports = { MinioBlobStore, PostgresConfigStore, MilvusVectorStore }
