const { readStorageConfig } = require('./config.cjs')
const { LocalBlobStore, LocalConfigStore, LocalVectorStore } = require('./local.cjs')
const { MinioBlobStore, PostgresConfigStore, MilvusVectorStore } = require('./remote.cjs')
const { createAccountFence } = require('./account-fence.cjs')
const { Pool } = require('pg')

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
  // Advisory-lock clients are held for the full request. Keep them separate
  // from application queries so a deployment configured with pool max=1 does
  // not deadlock when a fenced operation reads or writes config records.
  // pg hides options.password as a non-enumerable property. Spreading options
  // alone silently drops it and makes fenced writes fail SCRAM authentication.
  const fencePool = configStore.pool ? new Pool({ ...configStore.pool.options, password: configStore.pool.options.password, max: Math.max(1, Number(configStore.pool.options.max) || 10) }) : null
  const fence = createAccountFence({ localDataDirectory: config.localDataDirectory, pool: fencePool, getUserState: async (userId, client) => {
    if (typeof configStore.getUserState !== 'function') throw new Error('Storage 不支援帳號刪除圍欄')
    return configStore.getUserState(userId, client)
  } })
  let closing
  return {
    close: () => closing ??= Promise.all([blob, configStore, vector, fencePool].map(store => Promise.resolve().then(() => store?.close?.() ?? store?.end?.()))).then(() => undefined),
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
