const { createStorage } = require('../server/storage/index.cjs')

const main = async () => {
  const directory = process.env.S2T_LOCAL_CAS_DIRECTORY
  const writer = process.env.S2T_LOCAL_CAS_WRITER
  if (!directory || !writer) throw new Error('local CAS worker 缺少 directory 或 writer')
  const storage = createStorage({ S2T_LOCAL_DATA_DIR: directory })
  await storage.ready
  const won = await storage.config.compareAndSwap('cross-process', 'sessions', 0, { version: 1, sessions: [{ id: writer }] })
  process.stdout.write(JSON.stringify({ writer, won }))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
