const dotenv = require('dotenv')
const { createStorage } = require('../../server/storage/index.cjs')

dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })

const main = async () => {
  const scope = process.env.S2T_CAS_SCOPE
  const writer = process.env.S2T_CAS_WRITER
  if (!scope || !writer) throw new Error('CAS worker 缺少 scope 或 writer')
  const storage = createStorage(process.env)
  try {
    await storage.ready
    const won = await storage.config.compareAndSwap(scope, 'cross-process-cas', 0, { version: 1, writer })
    process.stdout.write(JSON.stringify({ won, writer }))
  } finally { await storage.config.pool?.end(); await storage.vector.client?.closeConnection?.() }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
