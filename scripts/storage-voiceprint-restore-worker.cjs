const { readFile } = require('node:fs/promises')
const dotenv = require('dotenv')
const { createStorage } = require('../server/storage/index.cjs')
const { restoreVoiceprints } = require('../server/storage/voiceprint-backup.cjs')

dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })

const main = async () => {
  const snapshotPath = process.argv[2]
  if (!snapshotPath) throw new Error('缺少聲紋快照路徑')
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  const storage = createStorage(process.env)
  try { await storage.ready; await restoreVoiceprints(storage, snapshot); process.stdout.write('restored') } finally {
    await storage.config.pool?.end()
    await storage.vector.client?.closeConnection?.()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
