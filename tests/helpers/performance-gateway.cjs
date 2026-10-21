// Isolated HTTP benchmark fixture: real gateway/auth/routes/SDK, memory storage.
// Does not contact the user's PG, Sentinel or MinIO and makes no claim about
// their network/disk capacity. The account-fence/Redis tests run separately.
const { randomUUID } = require('node:crypto')
const records = new Map()
for (let index = 0; index < 500; index++) {
  records.set(`auth:account-load${index}`, { id: `load_${index}`, username: `load${index}`, NT: `load${index}`, Department: 'load', role: 'user', deletionState: 'active', createdAt: new Date().toISOString() })
}
const chains = new Map()
const config = {
  ready: Promise.resolve(),
  get: async (scope, key) => records.get(`${scope}:${key}`) ?? null,
  put: async (scope, key, value) => { records.set(`${scope}:${key}`, value) },
  putIfAbsent: async (scope, key, value) => { const full = `${scope}:${key}`; if (records.has(full)) return false; records.set(full, value); return true },
  remove: async (scope, key) => { records.delete(`${scope}:${key}`) },
  list: async (scope, prefix = '') => [...records].filter(([key]) => key.startsWith(`${scope}:${prefix}`)).map(([key, value]) => ({ key: key.slice(scope.length + 1), value })),
  update: (scope, key, transform) => {
    const full = `${scope}:${key}`
    const task = (chains.get(full) || Promise.resolve()).catch(() => {}).then(async () => {
      const value = records.get(full) ?? null, next = await transform(value)
      if (next !== undefined) records.set(full, next)
      return { changed: next !== undefined, value: next === undefined ? value : next }
    })
    chains.set(full, task)
    task.finally(() => { if (chains.get(full) === task) chains.delete(full) }).catch(() => {})
    return task
  },
  updateAuthAccounts: async transform => transform([...records].filter(([key]) => key.startsWith('auth:account-')).map(([key, value]) => ({ key, value }))),
  getUserState: async id => [...records.values()].find(value => value?.id === id)?.deletionState || null
}
const blobs = new Map()
const storage = {
  config, ready: Promise.resolve(), schemaVersion: 'isolated-memory-fixture', mode: { config: 'local', blob: 'local', vector: 'local' },
  blob: { put: async (scope, key, value) => { blobs.set(`${scope}:${key}`, value) }, get: async (scope, key) => blobs.get(`${scope}:${key}`) ?? null, list: async () => [], remove: async () => {} },
  vector: {}, close: async () => {},
  withAccountWrite: async (id, operation) => { if (await config.getUserState(id) !== 'active') throw new Error('Account unavailable'); return operation() },
  withAccountDeletion: async (_id, operation) => operation()
}
// Exercise the real Sentinel admission path with a deterministic local Redis
// substitute. Pool/network behavior of the external service is tested elsewhere.
const sharedPath = require.resolve('../../server/shared-limits.cjs')
const shared = require(sharedPath)
const leases = new Map()
const redis = { isOpen: true, isReady: true, on() {}, destroy() {}, withCommandOptions() { return {
  ping: async () => 'PONG',
  eval: async (script, { keys: [key], arguments: args }) => {
    if (script === shared.WINDOW) return [1, 0, 1]
    const [maximum, ...tokens] = args
    const active = leases.get(key) || new Set(); leases.set(key, active)
    const granted = []
    for (const token of tokens) {
      if (active.has(token)) { granted.push(token); continue }
      if (active.size >= Number(maximum)) break
      active.add(token); granted.push(token)
    }
    return script === shared.ACQUIRE_BATCH ? granted : granted.length ? 1 : 0
  },
  zRem: async (key, tokens) => { for (const token of [tokens].flat()) leases.get(key)?.delete(token); return 1 }
} } }
require.cache[sharedPath].exports = { ...shared, createSharedLimits: (env, limits) => shared.createSharedLimits({ ...env, S2T_KUBERNETES_MODE: 'true', REDIS_URL: '', REDIS_SENTINEL_NODES: 'fixture', REDIS_SERVICE_NAME: 'fixture' }, limits, redis) }
const path = require.resolve('../../server/storage/index.cjs')
const original = require(path)
require.cache[path].exports = { ...original, createStorage: () => storage }
const runtime = require('../../server/index.cjs').startGateway()
process.once('SIGTERM', () => { void runtime.stop().then(() => process.exit(0), () => process.exit(1)) })
