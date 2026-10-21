const { BufferedS3Client: MinioClient } = require('./buffered-s3.cjs')
const { Pool } = require('pg')
const { postgresOptions, observePoolErrors } = require('./postgres-options.cjs')
const { adaptPostgresPool } = require('./adaptive-postgres.cjs')
const { createConcurrencyGate } = require('../concurrency-gate.cjs')
const { createRecordingBatches } = require('./recording-batches.cjs')
const { createRequestBatches } = require('./request-batches.cjs')
const { createCheckpointBatches } = require('./checkpoint-batches.cjs')
const { safePart, validateEmbedding, validateVectorRecord } = require('./local.cjs')
const { logger } = require('../logger.cjs')

const minioOptions = (config) => {
  const endpoint = new URL(config.S2T_MINIO_ENDPOINT.includes('://') ? config.S2T_MINIO_ENDPOINT : `http://${config.S2T_MINIO_ENDPOINT}`)
  return { endPoint: endpoint.hostname, port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80, useSSL: endpoint.protocol === 'https:', accessKey: config.S2T_MINIO_ACCESS_KEY, secretKey: config.S2T_MINIO_SECRET_KEY }
}
class MinioBlobStore {
  close() { this.closed = true; this.client.destroy() }
  constructor(config) {
    this.bucket = config.S2T_MINIO_BUCKET; this.client = new MinioClient(minioOptions(config))
    this.streams = createConcurrencyGate({ maximum: 8, maxWaiting: 1000, waitMs: 120000 })
    // Readiness failures name the component: without this line the aggregated
    // storage.ready rejection only says "connect ECONNREFUSED" and does not
    // tell an operator whether MinIO, Postgres or Milvus is the broken one.
    this.ready = this.initializeBucket().catch((error) => { logger.error('storage.blob.unavailable', { bucket: this.bucket, error }); throw error })
  }
  async initializeBucket() {
    const deadline = Date.now() + 30000
    let attempt = 0
    for (;;) {
      try { return await this.ensureBucket() }
      catch (error) {
        const transient = ['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','EAI_AGAIN','ENETUNREACH'].includes(error.code) || ['TimeoutError','RequestTimeout'].includes(error.name) || error.$metadata?.httpStatusCode >= 500
        if (this.closed || !transient || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, 100 * 2 ** Math.min(attempt++,4), deadline - Date.now())))
      }
    }
  }
  async ensureBucket() { if (!await this.client.bucketExists(this.bucket)) { try { await this.client.makeBucket(this.bucket) } catch (error) { if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.code || error.name) || !await this.client.bucketExists(this.bucket)) throw error } } }
  key(scope, key) { return `${safePart(scope, 'scope')}/${key.split('/').map((part) => safePart(part, 'blob key')).join('/')}` }
  async put(scope, key, bytes) { await this.ready; await this.client.putObject(this.bucket, this.key(scope, key), bytes) }
  async putStream(scope, key, stream, size) { await this.ready; return this.streams(() => this.client.putObject(this.bucket, this.key(scope, key), stream, size)) }
  async get(scope, key) { await this.ready; try { const stream = await this.client.getObject(this.bucket, this.key(scope, key)); const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) } catch (error) { if (error && error.code === 'NoSuchKey') return null; throw error } }
  async readStream(scope, key) { await this.ready; try { return await this.client.getObject(this.bucket, this.key(scope, key)) } catch (error) { if (error.code === 'NoSuchKey') return null; throw error } }
  async copy(scope, source, target) { await this.ready; await this.client.copyObject(this.bucket, this.key(scope, source), this.key(scope, target)) }
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
  async close() { await this.recordingBatches?.close(); await this.requestBatches?.close(); await this.checkpointBatches?.close(); await Promise.all([this.pool.end(), this.healthPool.end()]) }

  constructor(config) {
    this.pool = adaptPostgresPool(observePoolErrors(new Pool(postgresOptions(config)), 'queries'))
    this.healthPool = observePoolErrors(new Pool({ ...postgresOptions(config), max: 1, connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000 }), 'health')
    this.requestBatches = createRequestBatches(this.pool)
    this.recordingBatches = createRecordingBatches(this.pool)
    this.checkpointBatches = createCheckpointBatches(this.pool)
    this.schemaVersion = '002-account-deletion'
    this.ready = config.S2T_STORAGE_MIGRATIONS === 'verify' ? this.verifySchema() : this.migrate()
  }
  async health() {
    await this.ready
    const result = await this.healthPool.query('SELECT 1 FROM s2t_schema_migrations WHERE version=$1', [this.schemaVersion])
    if (!result.rowCount) throw new Error('Storage migration 記錄缺失')
  }
  async verifySchema() {
    let result
    try {
      result = await this.pool.query("SELECT 1 FROM s2t_schema_migrations WHERE version = $1", [this.schemaVersion])
      await this.pool.query('SELECT id, deletion_state FROM s2t_users LIMIT 0')
      await this.pool.query('SELECT scope, record_key FROM s2t_config_records LIMIT 0')
      await this.pool.query('SELECT lease_generation FROM s2t_diarization_jobs LIMIT 0')
    } catch (error) {
      if (error.code === '42P01' || error.code === '42703') throw new Error('Storage schema 缺失：請執行 node scripts/storage/recover-storage.cjs，完成後重新啟動 Gateway 與 worker；已刪資料需從備份還原。')
      throw error
    }
    if (!result.rowCount) throw new Error('Storage migration 記錄缺失：請執行 node scripts/storage/recover-storage.cjs，完成後重啟服務。')
  }
  async migrate() {
    // A failed migration must be the loudest line in the console: it is why
    // every request in this Pod answers 503 until an operator acts.
    const startedAt = Date.now()
    logger.info('storage.migration.started', { schemaVersion: this.schemaVersion })
    let client = null
    // Multiple gateway processes can start at the same time during a deploy.
    // DDL such as ALTER TABLE / CREATE INDEX otherwise takes locks in a
    // different order and can deadlock. Hold the advisory lock on one pooled
    // connection for the complete migration sequence.
    try {
      client = await this.pool.connect()
      await client.query("SELECT pg_advisory_lock(hashtext('s2t_schema_migrations'))")
      await client.query(`
      CREATE TABLE IF NOT EXISTS s2t_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nt TEXT NOT NULL,
        department TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        deletion_state TEXT NOT NULL DEFAULT 'active',
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
      ALTER TABLE s2t_users ADD COLUMN IF NOT EXISTS deletion_state TEXT NOT NULL DEFAULT 'active';
      CREATE INDEX IF NOT EXISTS s2t_users_deletion_state_index ON s2t_users(deletion_state);
      ALTER TABLE s2t_voiceprint_records ADD COLUMN IF NOT EXISTS sharing_scope TEXT NOT NULL DEFAULT 'private';
      ALTER TABLE s2t_diarization_jobs ADD COLUMN IF NOT EXISTS lease_generation INTEGER NOT NULL DEFAULT 0;
      INSERT INTO s2t_schema_migrations(version) VALUES ('001-core-storage') ON CONFLICT(version) DO NOTHING;
      INSERT INTO s2t_schema_migrations(version) VALUES ('002-account-deletion') ON CONFLICT(version) DO NOTHING;
    `)
    } catch (error) {
      logger.error('storage.migration.failed', { schemaVersion: this.schemaVersion, durationMs: Date.now() - startedAt, error })
      throw error
    } finally {
      if (client) {
        await client.query("SELECT pg_advisory_unlock(hashtext('s2t_schema_migrations'))").catch(() => undefined)
        client.release()
      }
    }
    logger.info('storage.migration.applied', { schemaVersion: this.schemaVersion, durationMs: Date.now() - startedAt })
  }
  async get(scope, key) { await this.ready; const result = await this.pool.query('SELECT value FROM s2t_config_records WHERE scope = $1 AND record_key = $2', [safePart(scope, 'scope'), safePart(key, 'record key')]); return result.rows[0]?.value ?? null }
  async getUserState(userId, client = this.pool) {
    await this.ready
    const result = await client.query('SELECT deletion_state FROM s2t_users WHERE id = $1', [safePart(userId, 'user id')])
    return !result.rowCount ? null : result.rows[0].deletion_state === 'deleting' ? 'deleting' : 'active'
  }
  async purgeAccount(userId) {
    await this.ready
    const ownerId = safePart(userId, 'user id'); const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM s2t_config_records WHERE scope = $1', [ownerId])
      await client.query('DELETE FROM s2t_diarization_jobs WHERE user_id = $1', [ownerId])
      await client.query('DELETE FROM s2t_voiceprint_records WHERE user_id = $1', [ownerId])
      await client.query('DELETE FROM s2t_glossaries WHERE user_id = $1', [ownerId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  }
  async put(scope, key, value) { await this.ready; await this.pool.query('INSERT INTO s2t_config_records(scope, record_key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT(scope, record_key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [safePart(scope, 'scope'), safePart(key, 'record key'), JSON.stringify(value)]) }
  async putCheckpoint(scope, key, value) {
    await this.ready
    if (!['live-draft','import-checkpoint'].includes(key)) throw new Error('Invalid checkpoint key')
    if (!await this.checkpointBatches.request({ scope:safePart(scope,'scope'),key,value })) throw Object.assign(new Error('帳號已不存在或正在刪除中'),{status:409,code:'ACCOUNT_DELETING'})
  }
  async compareAndSwap(scope, key, expectedVersion, value) {
    await this.ready
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('無效的資料版本')
    const cleanScope = safePart(scope, 'scope'); const cleanKey = safePart(key, 'record key')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // CAS only needs the version. Avoid transferring and parsing an entire
      // transcript snapshot a second time merely to check that scalar.
      const current = await client.query("SELECT CASE WHEN jsonb_typeof(value->'version') = 'number' THEN value->'version' END AS version FROM s2t_config_records WHERE scope = $1 AND record_key = $2 FOR UPDATE", [cleanScope, cleanKey])
      const version = Number.isSafeInteger(current.rows[0]?.version) ? current.rows[0].version : 0
      if (version !== expectedVersion) { await client.query('ROLLBACK'); return false }
      if (current.rowCount) await client.query('UPDATE s2t_config_records SET value = $3::jsonb, updated_at = NOW() WHERE scope = $1 AND record_key = $2', [cleanScope, cleanKey, JSON.stringify(value)])
      else {
        const inserted = await client.query('INSERT INTO s2t_config_records(scope, record_key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT(scope, record_key) DO NOTHING', [cleanScope, cleanKey, JSON.stringify(value)])
        if (!inserted.rowCount) { await client.query('ROLLBACK'); return false }
      }
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
  async update(scope, key, transform, { activeAccount } = {}) {
    await this.ready
    const cleanScope = safePart(scope, 'scope'); const cleanKey = safePart(key, 'record key')
    const client = await this.pool.connect()
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await client.query('BEGIN')
          if (activeAccount) {
            // Short account metadata writes share a row lock with each other;
            // markDeleting's UPDATE must wait for them to commit. No advisory
            // session or pool client is retained while inference is running.
            const owner = await client.query('SELECT deletion_state FROM s2t_users WHERE id = $1 FOR SHARE', [safePart(activeAccount, 'user id')])
            if (!owner.rowCount) throw Object.assign(new Error('帳號已不存在'), { status: 401, code: 'ACCOUNT_UNAVAILABLE' })
            if (owner.rows[0].deletion_state !== 'active') throw Object.assign(new Error('帳號正在刪除中'), { status: 409, code: 'ACCOUNT_DELETING' })
          }
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
  async updateRecording(scope, key, transform) {
    await this.ready
    const result = await this.recordingBatches.request({ scope: safePart(scope, 'scope'), key: safePart(key, 'record key'), transform })
    if (result.error) throw result.error
    return result
  }
  async updateForActiveAccount(userId, key, transform) { return this.update(userId, key, transform, { activeAccount: userId }) }
  async enqueueDiarizationJob({ id, userId, sessionId, audioKey, payload }) {
    await this.ready
    const ownerId = safePart(userId, 'user id')
    const result = await this.pool.query(`INSERT INTO s2t_diarization_jobs(id, user_id, session_id, audio_key, payload)
      SELECT $1, account.id, $3, $4, $5::jsonb FROM s2t_users account WHERE account.id = $2 AND account.deletion_state = 'active'
      ON CONFLICT(user_id, session_id, audio_key) DO UPDATE SET
      payload = CASE WHEN EXCLUDED.payload->>'processingToken' IS NOT NULL AND s2t_diarization_jobs.payload->>'processingToken' = EXCLUDED.payload->>'processingToken' THEN s2t_diarization_jobs.payload ELSE EXCLUDED.payload END,
      state = CASE WHEN EXCLUDED.payload->>'processingToken' IS NOT NULL AND s2t_diarization_jobs.payload->>'processingToken' = EXCLUDED.payload->>'processingToken' THEN s2t_diarization_jobs.state ELSE 'queued' END,
      attempts = CASE WHEN EXCLUDED.payload->>'processingToken' IS NOT NULL AND s2t_diarization_jobs.payload->>'processingToken' = EXCLUDED.payload->>'processingToken' THEN s2t_diarization_jobs.attempts ELSE 0 END,
      lease_owner = CASE WHEN EXCLUDED.payload->>'processingToken' IS NOT NULL AND s2t_diarization_jobs.payload->>'processingToken' = EXCLUDED.payload->>'processingToken' THEN s2t_diarization_jobs.lease_owner ELSE NULL END,
      lease_until = CASE WHEN EXCLUDED.payload->>'processingToken' IS NOT NULL AND s2t_diarization_jobs.payload->>'processingToken' = EXCLUDED.payload->>'processingToken' THEN s2t_diarization_jobs.lease_until ELSE NULL END,
      error = CASE WHEN EXCLUDED.payload->>'processingToken' IS NOT NULL AND s2t_diarization_jobs.payload->>'processingToken' = EXCLUDED.payload->>'processingToken' THEN s2t_diarization_jobs.error ELSE NULL END,
      updated_at = NOW()
      RETURNING id, state, attempts, created_at AS "createdAt", updated_at AS "updatedAt"`, [safePart(id, 'job id'), ownerId, safePart(sessionId, 'session id'), safePart(audioKey, 'audio key'), JSON.stringify(payload)])
    if (!result.rowCount) throw new Error('帳號已不存在或正在刪除中')
    return result.rows[0]
  }
  async getDiarizationJob(userId, id) { await this.ready; const result = await this.pool.query('SELECT id, state, attempts, error, created_at AS "createdAt", updated_at AS "updatedAt" FROM s2t_diarization_jobs WHERE user_id = $1 AND id = $2', [safePart(userId, 'user id'), safePart(id, 'job id')]); return result.rows[0] ?? null }
  async removeDiarizationJob(userId, id) { await this.ready; await this.pool.query('DELETE FROM s2t_diarization_jobs WHERE user_id = $1 AND id = $2', [safePart(userId, 'user id'), safePart(id, 'job id')]) }
  async claimDiarizationJob(owner, id = null) {
    await this.ready
    const result = await this.pool.query(`WITH candidate AS (
      SELECT job.id FROM s2t_diarization_jobs job
      JOIN s2t_users account ON account.id = job.user_id AND account.deletion_state = 'active'
      WHERE ($2::text IS NULL OR job.id = $2) AND ((job.state = 'queued' AND (job.lease_until IS NULL OR job.lease_until < NOW())) OR (job.state = 'running' AND job.lease_until < NOW()))
      ORDER BY job.created_at FOR UPDATE SKIP LOCKED LIMIT 1
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
  async renewDiarizationJob(id, owner, leaseGeneration) {
    await this.ready
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return false
    const result = await this.pool.query("UPDATE s2t_diarization_jobs SET lease_until = NOW() + INTERVAL '5 minutes', updated_at = NOW() WHERE id = $1 AND state = 'running' AND lease_owner = $2 AND lease_generation = $3 AND lease_until > NOW()", [safePart(id, 'job id'), safePart(owner, 'job owner'), leaseGeneration])
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
      updated_at = NOW() WHERE id = $1 AND state = 'running' AND lease_until > NOW() AND lease_owner = $2 AND lease_generation = $3`, [safePart(id, 'job id'), safePart(owner, 'job owner'), leaseGeneration, state, error ? String(error).replace(/^retry:/, '').slice(0, 1000) : null])
  }
  async commitDiarizationJob(id, owner, generation, userId, expectedVersion, value) {
    await this.ready
    if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('無效的工作或資料版本')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const job = await client.query("SELECT id FROM s2t_diarization_jobs WHERE id = $1 AND user_id = $2 AND state = 'running' AND lease_owner = $3 AND lease_generation = $4 AND lease_until > clock_timestamp() FOR UPDATE", [safePart(id, 'job id'), safePart(userId, 'user id'), safePart(owner, 'owner'), generation])
      if (!job.rowCount) { await client.query('ROLLBACK'); return 'lost' }
      const account = await client.query("SELECT id FROM s2t_users WHERE id = $1 AND deletion_state = 'active' FOR KEY SHARE", [safePart(userId, 'user id')])
      if (!account.rowCount) { await client.query('ROLLBACK'); return 'lost' }
      const record = await client.query("SELECT value FROM s2t_config_records WHERE scope = $1 AND record_key = 'sessions' FOR UPDATE", [userId])
      if (!record.rowCount || (record.rows[0].value?.version ?? 0) !== expectedVersion) { await client.query('ROLLBACK'); return 'conflict' }
      // Recheck using wall time after potentially waiting for the record lock.
      const finished = await client.query("UPDATE s2t_diarization_jobs SET state = 'completed', error = NULL, lease_owner = NULL, lease_until = NULL, updated_at = NOW() WHERE id = $1 AND lease_until > clock_timestamp() RETURNING id", [id])
      if (!finished.rowCount) { await client.query('ROLLBACK'); return 'lost' }
      await client.query("UPDATE s2t_config_records SET value = $2::jsonb, updated_at = NOW() WHERE scope = $1 AND record_key = 'sessions'", [userId, JSON.stringify(value)])
      await client.query('COMMIT')
      return 'committed'
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  }
  async claimRequest(userId, key, record) {
    await this.ready
    const value = await this.requestBatches.claims.request({ userId: safePart(userId, 'user id'), key: safePart(key, 'request key'), record })
    if (!value) throw Object.assign(new Error('帳號已不存在或正在刪除中'), { status: 409, code: 'ACCOUNT_DELETING' })
    return value
  }
  async completeRequest(userId, key, owner, record) {
    await this.ready
    return this.requestBatches.completions.request({ userId, key, owner, record })
  }
  async renewRequest(userId, key, owner) {
    await this.ready
    const now = Date.now()
    const result = await this.pool.query(`WITH account AS MATERIALIZED (
      SELECT id FROM s2t_users WHERE id = $1 AND deletion_state = 'active' FOR SHARE
    ) UPDATE s2t_config_records records SET value = records.value || jsonb_build_object('leaseUntil', $5::bigint), updated_at = NOW() FROM account
      WHERE records.scope = account.id AND records.record_key = $2 AND records.value->>'owner' = $3
        AND records.value->>'state' = 'running' AND (records.value->>'leaseUntil')::bigint > $4 RETURNING 1`, [userId, key, owner, now, now + 120000])
    return result.rowCount > 0
  }
  async failRequest(userId, key, owner) {
    await this.ready
    await this.pool.query(`UPDATE s2t_config_records SET value = value || '{"leaseUntil":0,"expiresAt":0}'::jsonb
      WHERE scope = $1 AND record_key = $2 AND value->>'owner' = $3`, [userId, key, owner])
  }
  async pruneExpiredRequests() {
    await this.ready
    // Walk the existing primary key in bounded pages. A full-table DELETE on
    // every Pod can hold thousands of row locks and time out repeatedly as
    // caption traffic grows. Never wait behind an active request's row lock.
    const cursor = this.requestPruneCursor || ['', '']
    const result = await this.pool.query(`WITH batch AS MATERIALIZED (
      SELECT scope,record_key FROM s2t_config_records
      WHERE (scope,record_key) > ($2::text,$3::text)
      ORDER BY scope,record_key LIMIT 1024
    ), expired AS MATERIALIZED (
      SELECT r.ctid FROM s2t_config_records r JOIN batch b USING(scope,record_key)
      WHERE r.record_key ~ '^request-[a-f0-9]{64}$'
        AND CASE WHEN jsonb_typeof(r.value->'expiresAt') = 'number'
          THEN (r.value->>'expiresAt')::numeric < $1 ELSE false END
      FOR UPDATE OF r SKIP LOCKED
    ), removed AS (
      DELETE FROM s2t_config_records r USING expired e WHERE r.ctid=e.ctid RETURNING 1
    ) SELECT scope,record_key,(SELECT count(*)::int FROM removed) AS removed
      FROM batch ORDER BY scope DESC,record_key DESC LIMIT 1`, [Date.now(), ...cursor])
    const last = result.rows[0]
    this.requestPruneCursor = last ? [last.scope, last.record_key] : null
    return last?.removed || 0
  }
  async diarizationBacklog() {
    await this.ready
    const result = await this.pool.query("SELECT COUNT(*)::int AS pending, COALESCE(SUM(COALESCE((payload->>'audioSeconds')::float, 60)), 0)::float AS \"audioSeconds\", COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0)::float AS oldest FROM s2t_diarization_jobs WHERE state IN ('queued', 'running')")
    return result.rows[0]
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
  async findVisibleVoiceprintIds({ userId, embeddingModel, embeddingVersion }) {
    await this.ready
    const result = await this.pool.query(`SELECT v.vector_id FROM s2t_voiceprint_records v
      LEFT JOIN s2t_config_records owner_auth ON owner_auth.scope = v.user_id AND owner_auth.record_key = 'sharing-authorization'
      LEFT JOIN s2t_config_records viewer_auth ON viewer_auth.scope = $1 AND viewer_auth.record_key = 'sharing-authorization'
      WHERE v.embedding_model = $2 AND v.embedding_version = $3 AND (v.user_id = $1 OR
        (viewer_auth.value->>'approved' = 'true' AND owner_auth.value->>'approved' = 'true' AND
          (v.sharing_scope = 'organization' OR (v.sharing_scope = 'department' AND
            COALESCE(viewer_auth.value->>'department', '') <> '' AND owner_auth.value->>'department' = viewer_auth.value->>'department'))))`,
      [safePart(userId, 'user id'), String(embeddingModel).slice(0, 512), String(embeddingVersion).slice(0, 128)])
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
        : await client.query('INSERT INTO s2t_glossaries(user_id, content, version) VALUES($1, $2, 1) ON CONFLICT(user_id) DO NOTHING RETURNING version, updated_at AS "updatedAt"', [safePart(userId, 'user id'), String(content).slice(0, 20_000)])
      // FOR UPDATE cannot lock a row that does not exist. Another gateway may
      // create it after our SELECT; report that lost first-write CAS normally.
      if (!result.rowCount) { await client.query('ROLLBACK'); return null }
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
