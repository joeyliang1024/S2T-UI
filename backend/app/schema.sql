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

CREATE TABLE IF NOT EXISTS s2t_python_vectors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES s2t_users(id) ON DELETE CASCADE, value JSONB NOT NULL);
INSERT INTO s2t_schema_migrations(version) VALUES ('003-python-runtime') ON CONFLICT(version) DO NOTHING;

-- Bound expiry cleanup to old request rows rather than scanning all user data.
CREATE INDEX IF NOT EXISTS s2t_request_expiry_index ON s2t_config_records (((value->>'expiresAt')::numeric)) WHERE record_key ~ '^request-[a-f0-9]{64}$';
INSERT INTO s2t_schema_migrations(version) VALUES ('004-request-expiry-index') ON CONFLICT(version) DO NOTHING;
