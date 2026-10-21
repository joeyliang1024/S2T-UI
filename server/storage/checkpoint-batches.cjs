const { writer } = require('./request-batches.cjs')

// Periodic drafts arrive in the same burst as ASR and recording chunks. One
// statement per bounded batch avoids hundreds of single-row autocommits taking
// every query slot. Concurrent snapshots of the same key share the last value
// in that batch; all acknowledgements follow its durable commit.
const createCheckpointBatches = pool => writer(async entries => {
  const unique = [...new Map(entries.map(entry => [JSON.stringify([entry.scope,entry.key]),entry])).values()]
  const result = await pool.query(`/* checkpoint batch */ WITH input AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(scope text,key text,value jsonb)
  ), account AS MATERIALIZED (
    SELECT id FROM s2t_users WHERE id IN (SELECT scope FROM input)
      AND deletion_state='active' ORDER BY id FOR SHARE
  ) INSERT INTO s2t_config_records(scope,record_key,value)
    SELECT scope,key,value FROM input JOIN account ON account.id=input.scope ORDER BY scope,key
    ON CONFLICT(scope,record_key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()
    RETURNING scope,record_key`,[JSON.stringify(unique)])
  const written = new Set(result.rows.map(row=>JSON.stringify([row.scope,row.record_key])))
  return entries.map(entry=>written.has(JSON.stringify([entry.scope,entry.key])))
})
module.exports = { createCheckpointBatches }
