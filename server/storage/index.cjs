const { readStorageConfig } = require('./config.cjs')
const { LocalBlobStore, LocalConfigStore, LocalVectorStore } = require('./local.cjs')
const { MinioBlobStore, PostgresConfigStore, MilvusVectorStore } = require('./remote.cjs')

const createStorage = (environment = process.env) => {
  const config = readStorageConfig(environment)
  const blob = config.minio ? new MinioBlobStore(config.minio) : new LocalBlobStore(config.localDataDirectory)
  const configStore = config.postgres ? new PostgresConfigStore(config.postgres) : new LocalConfigStore(config.localDataDirectory)
  const vector = config.milvus ? new MilvusVectorStore(config.milvus) : new LocalVectorStore(config.localDataDirectory)
  return {
    blob,
    config: configStore,
    vector,
    mode: { blob: config.minio ? 'minio' : 'local', config: config.postgres ? 'postgres' : 'local', vector: config.milvus ? 'milvus' : 'local' },
    ready: Promise.all([blob.ready, configStore.ready, vector.ready].filter(Boolean)).then(() => undefined)
  }
}

module.exports = { createStorage, ...require('./config.cjs') }
