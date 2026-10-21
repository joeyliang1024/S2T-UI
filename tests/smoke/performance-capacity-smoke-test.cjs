const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PostgresAccountFence } = require('../../server/storage/account-fence.cjs')
const { postgresOptions } = require('../../server/storage/postgres-options.cjs')
const { createSharedLimits } = require('../../server/shared-limits.cjs')
const { createConcurrencyGate } = require('../../server/concurrency-gate.cjs')
const { buildSync } = require('esbuild')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const load = entry => {
  const m = new module.constructor(); m.paths = module.paths
  m._compile(buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry)
  return m.exports
}
;(async () => {
  // The fake implements session-owned advisory locks, not connection-per-user.
  let connections = 0, destroyed = 0
  const clients = [], locks = new Map(), deleting = new Set()
  const pool = { connect: async () => {
    connections++
    const client = new EventEmitter()
    client.query = async (sql, [id]) => {
      await tick()
      if (sql.includes('pg_try_advisory_lock_shared')) {
        const lock = locks.get(id) || { shared: new Set(), exclusive: false }
        if (lock.exclusive) return { rows: [{ acquired: false }] }
        lock.shared.add(client); locks.set(id, lock)
        return { rows: [{ acquired: true }] }
      }
      if (sql.includes('pg_advisory_unlock_shared')) locks.get(id)?.shared.delete(client)
      else if (sql.includes('pg_advisory_unlock(')) locks.get(id).exclusive = false
      else if (sql.includes('pg_advisory_lock(')) {
        while (locks.get(id)?.shared.size || locks.get(id)?.exclusive) await tick()
        locks.set(id, { shared: new Set(), exclusive: true })
      }
      return { rows: [] }
    }
    client.release = broken => {
      if (broken) destroyed++
      for (const lock of locks.values()) lock.shared.delete(client)
    }
    clients.push(client)
    return client
  } }
  const fence = new PostgresAccountFence(pool, async id => deleting.has(id) ? 'deleting' : 'active')
  const release = deferred(), started = deferred()
  let running = 0, maximum = 0
  const writers = Array.from({ length: 500 }, (_, i) => fence.withWrite(`user_${i}`, async () => {
    running++; maximum = Math.max(maximum, running)
    if (running === 500) started.resolve()
    await release.promise
    running--
  }))
  await Promise.race([started.promise, delay(2500).then(() => assert.fail('500 writers did not enter concurrently'))])
  assert.equal(maximum, 500)
  assert.equal(connections, 1, '500 active accounts consume one shared fence session')
  deleting.add('user_0')
  let deleted = false
  const deletion = fence.withDeletion('user_0', async () => { deleted = true })
  await tick()
  assert.equal(deleted, false, 'deletion must wait for the existing writer')
  await assert.rejects(fence.withWrite('user_0', () => assert.fail('late writer')), { code: 'ACCOUNT_DELETING' })
  assert.equal(await fence.withWrite('other_user', async () => 'unblocked'), 'unblocked', 'deletion never blocks other accounts on the multiplexed session')
  release.resolve(); await Promise.all(writers); await deletion
  assert.equal(deleted, true)
  assert.equal(connections, 2)
  clients[0].emit('error', new Error('Connection terminated unexpectedly'))
  assert.equal(await fence.withWrite('replacement', async () => 'recovered'), 'recovered')
  assert.equal(connections, 3, 'a dead idle fence session is replaced')
  assert.equal(destroyed, 1)
  const activeRelease = deferred(), activeStarted = deferred()
  const lost = fence.withWrite('active_failure', async () => { activeStarted.resolve(); await activeRelease.promise })
  await activeStarted.promise
  clients.at(-1).emit('error', new Error('active session lost'))
  await assert.rejects(fence.withWrite('must_not_enter', async () => assert.fail()), /active session lost/)
  activeRelease.resolve(); await assert.rejects(lost, /active session lost/)
  assert.equal(await fence.withWrite('after_failure', async () => 'recovered again'), 'recovered again')
  await fence.close()
  const options = postgresOptions({})
  assert.equal(options.keepAlive, true)
  for (const field of ['connectionTimeoutMillis', 'statement_timeout', 'query_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout']) assert.ok(options[field] > 0, field)
  console.log('PASS 500 concurrent account writes, fixed PG session budget, cross-account deletion, idle/active disconnect recovery and finite PG timeouts')

  const gate = createConcurrencyGate({ maximum: 1, maxWaiting: 1, waitMs: 20 })
  const held = deferred()
  const first = gate(() => held.promise)
  const timeout = gate(async () => assert.fail('timed-out task executed'))
  await assert.rejects(gate(async () => assert.fail('overload executed')), { status: 503 })
  await assert.rejects(timeout, /timed out/)
  held.resolve(); await first
  assert.equal(await gate(async () => 'healthy'), 'healthy')

  // Simulate Sentinel command RTT; the real Lua script enforces the shared cap.
  // This tests scheduling, not real Redis failover or vLLM/GPU capacity.
  const leases = new Set()
  let modelActive = 0, modelMaximum = 0, acquireActive = 0, acquireMaximum = 0, acquireCalls = 0
  const redis = { isOpen: true, isReady: true, on() {}, destroy() {}, withCommandOptions() { return {
    eval: async (_script, { arguments: [limit, ...tokens] }) => {
      acquireCalls++
      acquireActive++; acquireMaximum = Math.max(acquireMaximum, acquireActive)
      await delay(5); acquireActive--
      const granted = []
      for (const token of tokens) {
        if (leases.has(token)) { granted.push(token); continue }
        if (leases.size >= Number(limit)) break
        leases.add(token); granted.push(token)
      }
      return granted
    },
    zRem: async (_key, tokens) => { for (const token of [tokens].flat()) leases.delete(token); return 1 }
  } } }
  const limits = createSharedLimits({ S2T_KUBERNETES_MODE: 'true', REDIS_SENTINEL_NODES: 'unused', REDIS_SERVICE_NAME: 'test', S2T_ASR_MAX_INFLIGHT: '512' }, {}, redis)
  const begin = performance.now()
  await Promise.all(Array.from({ length: 500 }, () => limits.withCapacity('asr', async () => {
    modelActive++; modelMaximum = Math.max(modelMaximum, modelActive)
    await delay(500); modelActive--
  })))
  const elapsed = performance.now() - begin
  assert.equal(acquireMaximum, 1, 'one batch probe in flight per bucket')
  assert.equal(acquireCalls, 4, '500 requests must be admitted with four bounded Redis commands')
  assert.equal(modelMaximum, 500, 'all 500 independent model calls may overlap when configured capacity allows')
  assert.ok(elapsed < 2500, `500 x 500ms scheduling took ${elapsed}ms`)
  await limits.close()
  assert.equal(leases.size, 0)
  console.log(`PASS 500 simultaneous calls at 500ms model latency: ${Math.round(elapsed)}ms wall time, peak model=${modelMaximum}, Redis commands=${acquireCalls}, probes in flight=${acquireMaximum} (simulated dependencies)`)

  const { orderedWindow } = load('src/renderer/src/shared/services/ordered-window.ts')
  const commits = [], produced = []
  let active = 0, peak = 0
  await orderedWindow({ start: 0, end: 12, concurrency: 4,
    produce: async i => { produced.push(i); active++; peak = Math.max(peak, active); await delay((4 - i % 4) * 5); active--; return i },
    commit: async i => { commits.push(i) }
  })
  assert.equal(peak, 4); assert.deepEqual(commits, Array.from({ length: 12 }, (_, i) => i))
  const prefix = [], sent = []
  await assert.rejects(orderedWindow({ start: 0, end: 12, concurrency: 4,
    produce: async i => { sent.push(i); if (i === 2) throw new Error('broken chunk'); await tick(); return i },
    commit: async i => { prefix.push(i) }
  }), /broken chunk/)
  assert.deepEqual(prefix, [0, 1]); assert.deepEqual(sent, [0, 1, 2, 3])

  const { OpenAiChunkedModelAdapter } = load('src/renderer/src/features/models/adapters/openai-chunked.ts')
  global.window = { setTimeout, clearTimeout }
  const answers = [], events = []
  const adapter = new OpenAiChunkedModelAdapter({ id: 'parallel', endpoint: '/unused', model: 'test', requiresApiKey: false }, {
    ensureReady: async () => {}, hasSpeech: async () => true,
    transcribe: () => { const answer = deferred(); answers.push(answer); return answer.promise }
  })
  await adapter.start({ sampleRate: 16000, language: 'en', targetLanguage: 'zh-TW' })
  adapter.onTranscript(event => events.push(event))
  for (let i = 0; i < 4; i++) adapter.enqueue(new Float32Array(1600).fill(.1), i * 1600)
  assert.equal(answers.length, 4, 'live ASR starts four requests without awaiting the first')
  for (let i = 3; i >= 1; i--) answers[i].resolve({ text: `caption number ${i}` })
  await tick(); assert.equal(events.length, 0, 'completed responses wait for earlier audio before publication')
  answers[0].resolve({ text: 'caption number zero' }); await adapter.stop()
  assert.deepEqual(events.map(event => event.id), ['http-0', 'http-1', 'http-2', 'http-3'])
  console.log('PASS parallel live ASR preserves caption order; parallel imports keep ordered checkpoints and stop scheduling after failure')
})().catch(error => { console.error(error); process.exitCode = 1 })
