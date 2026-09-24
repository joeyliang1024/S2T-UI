const path = require('node:path')

class StorageConfigurationError extends Error {}

const defined = (value) => typeof value === 'string' && value.trim() !== ''
const requiredGroup = (environment, label, names) => {
  const present = names.filter((name) => defined(environment[name]))
  if (present.length === 0) return null
  if (present.length !== names.length) {
    const missing = names.filter((name) => !defined(environment[name]))
    throw new StorageConfigurationError(`${label} 已部分設定，缺少：${missing.join(', ')}`)
  }
  return Object.fromEntries(names.map((name) => [name, environment[name].trim()]))
}

const readStorageConfig = (environment = process.env) => {
  const minio = requiredGroup(environment, 'MinIO', [
    'S2T_MINIO_ENDPOINT', 'S2T_MINIO_BUCKET', 'S2T_MINIO_ACCESS_KEY', 'S2T_MINIO_SECRET_KEY'
  ])
  const postgres = requiredGroup(environment, 'PostgreSQL', [
    'S2T_POSTGRES_HOST', 'S2T_POSTGRES_PORT', 'S2T_POSTGRES_DB_NAME', 'S2T_POSTGRES_USER', 'S2T_POSTGRES_PASSWORD'
  ])
  const milvus = requiredGroup(environment, 'Milvus', [
    'S2T_MILVUS_ENDPOINT', 'S2T_MILVUS_DB_NAME', 'S2T_MILVUS_COLLECTION', 'S2T_MILVUS_TOKEN'
  ])
  if (postgres && (!Number.isInteger(Number(postgres.S2T_POSTGRES_PORT)) || Number(postgres.S2T_POSTGRES_PORT) < 1)) {
    throw new StorageConfigurationError('S2T_POSTGRES_PORT 必須是有效連接埠。')
  }
  return {
    minio,
    postgres,
    milvus,
    localDataDirectory: path.resolve(environment.S2T_LOCAL_DATA_DIR || path.join(process.cwd(), '.s2t-data'))
  }
}

module.exports = { StorageConfigurationError, readStorageConfig }
