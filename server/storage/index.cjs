const { readStorageConfig } = require('./config.cjs')
const { LocalBlobStore, LocalConfigStore, LocalVectorStore } = require('./local.cjs')
const { MinioBlobStore, PostgresConfigStore, MilvusVectorStore } = require('./remote.cjs')
const { createAccountFence } = require('./account-fence.cjs')
const { Pool } = require('pg')
const { observePoolErrors } = require('./postgres-options.cjs')

// Kubernetes 模式代表多副本分散部署，Pod 本地 storage 會讓帳號、歷史、字幕在副本間不一致，
// 因此 blob（MinIO）與 config（PostgreSQL）必須是共享後端。
// vector（聲紋 embedding）目前只服務尚未對使用者開放的聲紋系統，允許維持 Pod 本地，
// 不強制安裝 Milvus；等聲紋正式開放時再決定是否收緊。
const kubernetesConfigError = (environment = process.env, mode = {}) => environment.S2T_KUBERNETES_MODE === 'true' && [mode.blob, mode.config].some((value) => value === 'local')
  ? new Error('Kubernetes 模式必須設定共享 MinIO 與 PostgreSQL，不能使用 Pod 本地 storage（vector 可維持本地）')
  : null

const createStorage = (environment = process.env) => {
  const config = readStorageConfig(environment)
  const blob = config.minio ? new MinioBlobStore(config.minio) : new LocalBlobStore(config.localDataDirectory)
  const configStore = config.postgres ? new PostgresConfigStore(config.postgres) : new LocalConfigStore(config.localDataDirectory)
  const vector = config.milvus ? new MilvusVectorStore(config.milvus) : new LocalVectorStore(config.localDataDirectory)
  const fenceSessions = Number(config.postgres?.S2T_POSTGRES_FENCE_SESSIONS || 4)
  if (!Number.isSafeInteger(fenceSessions) || fenceSessions < 1 || fenceSessions > 16) throw new Error('S2T_POSTGRES_FENCE_SESSIONS must be in 1..16')
  // Bounded multiplexed shared-lock sessions plus one exclusive deletion session.
  // This budget is fixed per process, independent of users or in-flight HTTP.
  // Keep it separate from query/transaction capacity (including pool max=1).
  const fencePool = configStore.pool ? observePoolErrors(new Pool({ ...configStore.pool.options, password: configStore.pool.options.password, max: fenceSessions + 1 }), 'account-fence') : null
  const fence = createAccountFence({ localDataDirectory: config.localDataDirectory, pool: fencePool, sharedSessions: fenceSessions, getUserState: async (userId, client) => {
    if (typeof configStore.getUserState !== 'function') throw new Error('Storage 不支援帳號刪除圍欄')
    return configStore.getUserState(userId, client)
  } })
  let closing
  return {
    close: () => closing ??= Promise.resolve().then(() => fence.close?.()).then(() => Promise.all([blob, configStore, vector, fencePool].map(store => Promise.resolve().then(() => store?.close?.() ?? store?.end?.())))).then(() => undefined),
    minioStats: () => blob.client?.stats?.() || {},
    postgresStats: () => Object.fromEntries([['queries', configStore.pool], ['fence', fencePool], ['health', configStore.healthPool]].filter(([, pool]) => pool).map(([role, pool]) => [role, { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, maximum: pool.options.max, ...(pool.adaptiveStats?.() || {}) }])),
    blob,
    config: configStore,
    vector,
    withAccountWrite: (userId, operation) => fence.withWrite(userId, operation),
    drainAccountWrites: (userId) => fence.withDeletion(userId, async () => undefined),
    withAccountDeletion: (userId, operation) => fence.withDeletion(userId, operation),
    mode: { blob: config.minio ? 'minio' : 'local', config: config.postgres ? 'postgres' : 'local', vector: config.milvus ? 'milvus' : 'local' },
    schemaVersion: config.postgres ? configStore.schemaVersion : 'local-v1',
    ready: Promise.all([blob.ready, configStore.ready, vector.ready].filter(Boolean)).then(() => undefined)
  }
}

module.exports = { createStorage, kubernetesConfigError, ...require('./config.cjs') }
