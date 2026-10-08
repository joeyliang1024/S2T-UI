const { config } = require('dotenv')
config({ quiet: true })
const { readStorageConfig } = require('../../server/storage/config.cjs')
const { PostgresConfigStore } = require('../../server/storage/remote.cjs')
;(async () => {
  const settings = readStorageConfig(process.env)
  if (!settings.postgres) throw new Error('Schema migration requires PostgreSQL configuration')
  const store = new PostgresConfigStore({ ...settings.postgres, S2T_STORAGE_MIGRATIONS: 'auto' })
  try { await store.ready; console.log('Storage schema ready') } finally { await store.pool.end() }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
