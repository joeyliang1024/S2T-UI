// Operator recovery: recreate missing schema and a missing bootstrap admin.
// Never drops tables, overwrites existing credentials, or adopts orphaned data.
require('dotenv').config({ quiet: true })
const bcrypt = require('bcryptjs')
const { readStorageConfig } = require('../../server/storage/config.cjs')
const { PostgresConfigStore } = require('../../server/storage/remote.cjs')
const { PostgresUserStore } = require('../../server/auth/user-store.cjs')
async function recover(environment = process.env) {
  const settings = readStorageConfig(environment)
  if (!settings.postgres) throw new Error('Recovery requires PostgreSQL configuration')
  const username = environment.S2T_BOOTSTRAP_ADMIN_USERNAME?.trim()
  const password = environment.S2T_BOOTSTRAP_ADMIN_PASSWORD?.trim()
  if (!username || !password) throw new Error('Set S2T_BOOTSTRAP_ADMIN_USERNAME and S2T_BOOTSTRAP_ADMIN_PASSWORD before recovery')
  const store = new PostgresConfigStore({ ...settings.postgres, S2T_STORAGE_MIGRATIONS: 'auto' })
  try {
    await store.ready
    const users = new PostgresUserStore(store.pool)
    const existing = await users.findByUsername(username)
    if (existing && existing.role !== 'admin') throw new Error('Configured bootstrap username belongs to a non-admin account; choose another username')
    if (!existing) {
      try { await users.create({ username, passwordHash: await bcrypt.hash(password, 12), NT: username, Department: 'admin', role: 'admin' }) }
      catch (error) { const winner = await users.findByUsername(username); if (!winner || winner.role !== 'admin') throw error }
    }
    return { schemaReady: true, adminReady: true, existingAdminPreserved: Boolean(existing) }
  } finally { await store.pool.end() }
}
module.exports = { recover }
if (require.main === module) recover().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1 })
