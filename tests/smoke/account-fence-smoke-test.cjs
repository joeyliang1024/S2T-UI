const assert = require('node:assert/strict')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path'), { tmpdir } = require('node:os')
const { LocalAccountFence, PostgresAccountFence } = require('../../server/storage/account-fence.cjs')

;(async () => {
  const directory = await mkdtemp(join(tmpdir(), 's2t-account-fence-'))
  try {
    let state = 'active'; let release; const blocked = new Promise(resolve => { release = resolve })
    const fence = new LocalAccountFence(directory, async () => state)
    const active = fence.withWrite('owner_a', async () => { await blocked; return 'written' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const deletion = fence.withDeletion('owner_a', async () => 'deleted')
    await new Promise(resolve => setTimeout(resolve, 10))
    await assert.rejects(fence.withWrite('owner_a', async () => 'late'), error => error.code === 'ACCOUNT_DELETING' && error.status === 409)
    release(); assert.equal(await active, 'written'); assert.equal(await deletion, 'deleted')
    state = 'deleting'; await assert.rejects(fence.withWrite('owner_a', async () => undefined), error => error.code === 'ACCOUNT_DELETING')
    state = 'active'; await assert.rejects(fence.withWrite('owner_b', async () => { throw Error('write failure') }), /write failure/)
    assert.equal(await fence.withWrite('owner_b', async () => 'released'), 'released')
    const fenceRoot = join(directory, '.account-fences')
    await writeFile(join(fenceRoot, 'owner_stale.writer-crashed'), `999999\n${Date.now() - 61_000}\n`)
    await writeFile(join(fenceRoot, 'owner_stale.delete-lock'), `999999\n${Date.now() - 61_000}\n`)
    assert.equal(await fence.withDeletion('owner_stale', async () => 'reaped'), 'reaped', 'a dead writer and dead deletion owner are reaped for retry')
    fence.drainTimeoutMs = 40
    await writeFile(join(fenceRoot, 'owner_alive.writer-long'), `${process.pid}\n${Date.now() - 61_000}\n`)
    await assert.rejects(fence.withDeletion('owner_alive', async () => 'unsafe'), error => error.code === 'ACCOUNT_WRITES_DRAINING', 'a live long-running writer is never reclaimed')
    await rm(join(fenceRoot, 'owner_alive.writer-long'))
    const calls = []; const client = { query: async (sql, values) => calls.push([sql, values]), release: () => calls.push(['release']) }
    const pg = new PostgresAccountFence({ connect: async () => client }, async () => 'active')
    assert.equal(await pg.withWrite('owner_c', async () => 'pg-write'), 'pg-write')
    assert.match(calls[0][0], /pg_advisory_lock_shared/); assert.match(calls.at(-2)[0], /pg_advisory_unlock_shared/)
    console.log('PASS account fence drains local writers, rejects new writers, releases failures, and uses PostgreSQL advisory locks')
  } finally { await rm(directory, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
