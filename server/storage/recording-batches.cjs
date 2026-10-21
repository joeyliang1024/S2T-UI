const { writer } = require('./request-batches.cjs')
const createRecordingBatches = pool => writer(async entries => {
  const client = await pool.connect()
  const keys = [...new Map(entries.map(({ scope, key }) => [JSON.stringify([scope, key]), { scope, key }])).values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key))
  try {
    await client.query('BEGIN')
    // Every owner is checked under a shared row lock until this durable commit.
    const owners = await client.query("SELECT id FROM s2t_users WHERE id = ANY($1::text[]) AND deletion_state = 'active' ORDER BY id FOR SHARE", [[...new Set(keys.map(x => x.scope))]])
    const active = new Set(owners.rows.map(x => x.id))
    const valid = keys.filter(x => active.has(x.scope))
    if (valid.length) await client.query(`INSERT INTO s2t_config_records(scope,record_key,value)
      SELECT scope,key,'null'::jsonb FROM jsonb_to_recordset($1::jsonb) AS x(scope text,key text) ORDER BY scope,key ON CONFLICT DO NOTHING`, [JSON.stringify(valid)])
    const rows = valid.length ? await client.query(`SELECT r.scope,r.record_key,r.value FROM s2t_config_records r JOIN jsonb_to_recordset($1::jsonb) AS x(scope text,key text) ON r.scope=x.scope AND r.record_key=x.key ORDER BY r.scope,r.record_key FOR UPDATE OF r`, [JSON.stringify(valid)]) : { rows: [] }
    const values = new Map(rows.rows.map(x => [JSON.stringify([x.scope, x.record_key]), x.value]))
    const emptyKeys = new Set([...values].filter(([, value]) => value === null).map(([key]) => key))
    const changed = new Map(), results = []
    for (const entry of entries) {
      const key = JSON.stringify([entry.scope, entry.key]), stored = values.get(key) ?? null
      try {
        if (!active.has(entry.scope)) throw Object.assign(new Error('帳號已不存在或正在刪除中'), { status: 409, code: 'ACCOUNT_DELETING' })
        // Recording transforms are synchronous pure metadata operations; clone
        // so a rejected transform cannot mutate another operation's snapshot.
        const outcome = entry.transform(structuredClone(stored))
        if (outcome?.then) throw new Error('Recording metadata transforms must be synchronous')
        if (outcome === undefined) results.push({ changed: false, value: stored })
        else { values.set(key, outcome); changed.set(key, { scope: entry.scope, key: entry.key, value: outcome }); results.push({ changed: true, value: outcome }) }
      } catch (error) { results.push({ error }) }
    }
    const unused = valid.filter(item => emptyKeys.has(JSON.stringify([item.scope,item.key])) && !changed.has(JSON.stringify([item.scope,item.key])))
    if (unused.length) await client.query(`DELETE FROM s2t_config_records r USING jsonb_to_recordset($1::jsonb) AS x(scope text,key text) WHERE r.scope=x.scope AND r.record_key=x.key AND r.value='null'::jsonb`, [JSON.stringify(unused)])
    if (changed.size) await client.query(`UPDATE s2t_config_records r SET value=x.value,updated_at=NOW() FROM jsonb_to_recordset($1::jsonb) AS x(scope text,key text,value jsonb) WHERE r.scope=x.scope AND r.record_key=x.key`, [JSON.stringify([...changed.values()])])
    await client.query('COMMIT')
    return results
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}, { concurrency: 2 })
module.exports = { createRecordingBatches }
