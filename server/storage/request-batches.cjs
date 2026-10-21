const fail = message => Object.assign(new Error(message), { status: 503 })
// Coalesce small durable lease writes. Every batch still commits to PG with
// normal fsync; this removes per-caption transactions without moving durable
// request state to Redis or weakening deletion fencing.
const writer = (execute, { maxBatch = 128, maximumPending = 2000, concurrency = 4, waitMs = 3000 } = {}) => {
  let queue = [], active = 0, timer, closing = false
  const drains = []
  const flush = () => {
    clearTimeout(timer); timer = null
    while (active < concurrency && queue.length) {
      const batch = queue.splice(0, maxBatch)
      for (const entry of batch) clearTimeout(entry.timer)
      active++
      Promise.resolve().then(() => execute(batch.map(entry => entry.value))).then(
        results => { for (let i = 0; i < batch.length; i++) batch[i].resolve(results[i]) },
        error => { for (const entry of batch) entry.reject(error) }
      ).finally(() => {
        active--; flush()
        if (!active && !queue.length) for (const resolve of drains.splice(0)) resolve()
      })
    }
  }
  return {
    request(value) {
      if (closing || queue.length >= maximumPending) return Promise.reject(fail('Request metadata queue unavailable'))
      return new Promise((resolve, reject) => {
        const entry = { value, resolve, reject, timer: null }
        if (waitMs) entry.timer = setTimeout(() => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(fail('Request metadata admission timed out')) }, waitMs)
        queue.push(entry)
        if (!timer) timer = setTimeout(flush, 2)
      })
    },
    async close() { closing = true; flush(); if (active || queue.length) await new Promise(resolve => drains.push(resolve)) },
    stats: () => ({ queued: queue.length, batches: active })
  }
}
const keyOf = value => JSON.stringify([value.userId, value.key])
const createRequestBatches = pool => {
  const claims = writer(async entries => {
    // Duplicate retries in the same batch share the first claim, then callers
    // independently apply fingerprint/owner checks to its authoritative value.
    const unique = [...new Map(entries.map(entry => [keyOf(entry), entry]).reverse()).values()]
    const result = await pool.query(`WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS item("userId" text, key text, record jsonb)
    ), account AS MATERIALIZED (
      SELECT id FROM s2t_users WHERE id IN (SELECT "userId" FROM input) AND deletion_state = 'active' ORDER BY id FOR SHARE
    ) INSERT INTO s2t_config_records(scope,record_key,value)
      SELECT input."userId",input.key,input.record FROM input JOIN account ON account.id = input."userId"
      ON CONFLICT(scope,record_key) DO UPDATE SET value = CASE
        WHEN COALESCE((s2t_config_records.value->>'expiresAt')::bigint,0) <= $2
          OR (s2t_config_records.value->>'fingerprint' = EXCLUDED.value->>'fingerprint' AND s2t_config_records.value->>'state' = 'running' AND COALESCE((s2t_config_records.value->>'leaseUntil')::bigint,0) <= $2)
        THEN EXCLUDED.value ELSE s2t_config_records.value END
      RETURNING scope,record_key,value`, [JSON.stringify(unique), Date.now()])
    const found = new Map(result.rows.map(row => [JSON.stringify([row.scope, row.record_key]), row.value]))
    return entries.map(entry => found.get(keyOf(entry)) ?? null)
  })
  const completions = writer(async entries => {
    const unique = [...new Map(entries.map(entry => [JSON.stringify([entry.userId, entry.key, entry.owner]), entry]).reverse()).values()]
    const result = await pool.query(`WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS item("userId" text,key text,owner text,record jsonb)
    ), account AS MATERIALIZED (
      SELECT id FROM s2t_users WHERE id IN (SELECT "userId" FROM input) AND deletion_state = 'active' ORDER BY id FOR SHARE
    ) UPDATE s2t_config_records records SET value = input.record, updated_at = NOW() FROM input JOIN account ON account.id = input."userId"
      WHERE records.scope = input."userId" AND records.record_key = input.key
        AND records.value->>'owner' = input.owner AND records.value->>'state' = 'running'
        AND (records.value->>'leaseUntil')::bigint > $2
      RETURNING records.scope,records.record_key,input.owner`, [JSON.stringify(unique), Date.now()])
    const found = new Set(result.rows.map(row => JSON.stringify([row.scope, row.record_key, row.owner])))
    return entries.map(entry => found.has(JSON.stringify([entry.userId, entry.key, entry.owner])))
  })
  return { claims, completions, close: () => Promise.all([claims.close(), completions.close()]) }
}
module.exports = { createRequestBatches, writer }
