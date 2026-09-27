const assert = require('node:assert/strict')
const { mkdir, readdir, readFile, rename, writeFile } = require('node:fs/promises')
const { join, relative, sep } = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const dotenv = require('dotenv')
const { LocalBlobStore, LocalConfigStore, LocalVectorStore } = require('../server/storage/local.cjs')
const { createStorage } = require('../server/storage/index.cjs')

dotenv.config({ path: process.env.S2T_STORAGE_ENV_FILE || '.env.local-storage', quiet: true })

const apply = process.argv.includes('--apply')
const adoptMatchingUsers = process.argv.includes('--adopt-matching-users')
const sourceDirectory = process.env.S2T_MIGRATION_SOURCE_DIR || process.env.S2T_LOCAL_DATA_DIR || join(process.cwd(), '.s2t-data')
const summary = { users: 0, adoptedUsers: 0, mappedUnownedScopes: 0, config: 0, glossaries: 0, blobs: 0, vectors: 0, voiceprintMetadata: 0, skipped: 0, unowned: [], conflicts: [] }
const accountKey = /^account-([a-z0-9._-]{3,64})$/
const migrationJournalFile = join(sourceDirectory, 'migration-last-run.json')
const explicitScopeMap = (() => {
  const raw = process.env.S2T_MIGRATION_SCOPE_MAP_JSON
  if (!raw) return new Map()
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be an object')
    return new Map(Object.entries(parsed).flatMap(([source, target]) => typeof source === 'string' && typeof target === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(source) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(target) ? [[source, target]] : []))
  } catch { throw new Error('S2T_MIGRATION_SCOPE_MAP_JSON 必須是 {"舊 scope":"外部 user ID"} JSON 物件') }
})()

const walkFiles = async (root, directory = root) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
  }
  return files
}
const conflict = (description) => { summary.conflicts.push(description) }
const unowned = (description) => { if (!summary.unowned.includes(description)) summary.unowned.push(description) }
const resolveScope = (sourceScope, userIds) => userIds.get(sourceScope) || explicitScopeMap.get(sourceScope)

const readJournal = async () => {
  try { const value = JSON.parse(await readFile(migrationJournalFile, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error }
}
const writeJournal = async (value) => {
  await mkdir(sourceDirectory, { recursive: true })
  const temporary = `${migrationJournalFile}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, migrationJournalFile)
}

const validateExplicitScopeMap = async (target) => {
  if (!explicitScopeMap.size) return
  const destinations = [...new Set(explicitScopeMap.values())]
  const result = await target.config.pool.query('SELECT id FROM s2t_users WHERE id = ANY($1::text[])', [destinations])
  const known = new Set(result.rows.map((row) => row.id))
  const missing = destinations.filter((id) => !known.has(id))
  if (missing.length) throw new Error(`S2T_MIGRATION_SCOPE_MAP_JSON 指向不存在的外部 user ID：${missing.join(', ')}`)
  summary.mappedUnownedScopes = explicitScopeMap.size
}

const migrateUser = async (target, username, user, userIds) => {
  if (!user || typeof user !== 'object' || typeof user.id !== 'string' || typeof user.passwordHash !== 'string' || typeof user.NT !== 'string' || typeof user.Department !== 'string') return conflict(`帳號 ${username} 格式無效`)
  const existing = await target.config.pool.query('SELECT id, username, nt, department FROM s2t_users WHERE username = $1 OR lower(nt) = lower($2)', [username, user.NT])
  if (existing.rowCount) {
    const match = existing.rows.find((entry) => entry.username === username)
    if (!match || match.nt !== user.NT || match.department !== user.Department) return conflict(`帳號 ${username} 或 NT ${user.NT} 已在外部服務存在不同資料`)
    if (match.id !== user.id) {
      if (!adoptMatchingUsers) return conflict(`帳號 ${username} 已有相同 NT／部門但 user ID 不同；使用 --adopt-matching-users 才會把舊資料搬到外部帳號`)
      userIds.set(user.id, match.id)
      summary.adoptedUsers += 1
      return
    }
    userIds.set(user.id, user.id)
    summary.skipped += 1
    return
  }
  summary.users += 1
  userIds.set(user.id, user.id)
  if (apply) await target.config.pool.query('INSERT INTO s2t_users(id, username, password_hash, nt, department, role, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), NOW())', [user.id, username, user.passwordHash, user.NT, user.Department, user.role === 'admin' ? 'admin' : 'user', typeof user.createdAt === 'string' ? user.createdAt : null])
}

const migrateConfig = async (source, target) => {
  const records = await source.config.records()
  const users = []
  for (const [compoundKey, entry] of Object.entries(records)) {
    if (!compoundKey.startsWith('auth:')) continue
    const key = compoundKey.slice('auth:'.length)
    const match = key.match(accountKey)
    if (match) users.push([match[1], entry?.value])
  }
  const userIds = new Map()
  for (const [username, user] of users) await migrateUser(target, username, user, userIds)

  for (const [compoundKey, entry] of Object.entries(records)) {
    const separator = compoundKey.indexOf(':')
    if (separator < 1 || !entry || !Object.hasOwn(entry, 'value')) { conflict(`設定 key ${compoundKey} 格式無效`); continue }
    const sourceScope = compoundKey.slice(0, separator); const scope = resolveScope(sourceScope, userIds); const key = compoundKey.slice(separator + 1)
    if (sourceScope === 'auth') continue
    if (!scope) { unowned(`設定 ${sourceScope}:${key} 未對應已知帳號，未遷移`); continue }
    if (key === 'glossary' && typeof entry.value === 'string') {
      const current = await target.config.getGlossary(scope)
      if (current.content && current.content !== entry.value) { conflict(`術語 ${scope} 已在外部服務存在不同內容`); continue }
      if (current.content === entry.value) { summary.skipped += 1; continue }
      summary.glossaries += 1
      if (apply) await target.config.putGlossary(scope, entry.value, current.version)
      continue
    }
    const current = await target.config.get(scope, key)
    if (current !== null && !isDeepStrictEqual(current, entry.value)) { conflict(`設定 ${scope}:${key} 已在外部服務存在不同內容`); continue }
    if (current !== null) { summary.skipped += 1; continue }
    summary.config += 1
    if (apply) await target.config.put(scope, key, entry.value)
  }
  return { records, userIds }
}

const migrateBlobs = async (source, target, userIds) => {
  const root = source.blob.root
  for (const sourceScope of await readdir(root, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!sourceScope.isDirectory()) continue
    const scope = resolveScope(sourceScope.name, userIds)
    if (!scope) { unowned(`blob scope ${sourceScope.name} 未對應已知帳號，未遷移`); continue }
    for (const key of await walkFiles(join(root, sourceScope.name))) {
      const current = await target.blob.get(scope, key)
      const bytes = await source.blob.get(sourceScope.name, key)
      if (!bytes) continue
      if (current && !current.equals(bytes)) { conflict(`音檔 ${scope}/${key} 已在外部服務存在不同內容`); continue }
      if (current) { summary.skipped += 1; continue }
      summary.blobs += 1
      if (apply) await target.blob.put(scope, key, bytes)
    }
  }
}

const migrateVectors = async (source, target, records, userIds) => {
  const vectors = await source.vector.records()
  const ownedVectorIds = new Set()
  for (const [compoundKey, entry] of Object.entries(records)) {
    const sourceUserId = compoundKey.endsWith(':voiceprints') ? compoundKey.slice(0, -':voiceprints'.length) : null
    if (sourceUserId && resolveScope(sourceUserId, userIds) && Array.isArray(entry?.value)) entry.value.forEach((voiceprint) => { if (typeof voiceprint?.id === 'string') ownedVectorIds.add(voiceprint.id) })
  }
  for (const vector of vectors) {
    if (!ownedVectorIds.has(vector.id)) { unowned(`向量 ${vector.id} 沒有已知帳號的聲紋 metadata，未遷移`); continue }
    summary.vectors += 1; if (apply) await target.vector.upsert(vector)
  }
  for (const [compoundKey, entry] of Object.entries(records)) {
    if (!compoundKey.endsWith(':voiceprints') || !Array.isArray(entry?.value)) continue
    const sourceUserId = compoundKey.slice(0, -':voiceprints'.length); const userId = resolveScope(sourceUserId, userIds)
    if (!userId) { unowned(`聲紋 metadata ${sourceUserId} 未對應已知帳號，未遷移`); continue }
    for (const voiceprint of entry.value) {
      if (!voiceprint || typeof voiceprint.id !== 'string' || typeof voiceprint.embeddingModel !== 'string' || typeof voiceprint.embeddingVersion !== 'string') continue
      const sharingScope = voiceprint.sharingScope || 'private'
      const existing = await target.config.pool.query('SELECT user_id, embedding_model, embedding_version, sharing_scope FROM s2t_voiceprint_records WHERE vector_id = $1', [voiceprint.id])
      if (existing.rowCount) {
        const metadata = existing.rows[0]
        if (metadata.user_id !== userId || metadata.embedding_model !== voiceprint.embeddingModel || metadata.embedding_version !== voiceprint.embeddingVersion || metadata.sharing_scope !== sharingScope) conflict(`聲紋 metadata ${voiceprint.id} 已在外部服務存在不同內容`)
        else summary.skipped += 1
        continue
      }
      summary.voiceprintMetadata += 1
      if (apply) await target.config.createVoiceprint({ vectorId: voiceprint.id, userId, embeddingModel: voiceprint.embeddingModel, embeddingVersion: voiceprint.embeddingVersion, sharingScope })
    }
  }
}

const main = async () => {
  const source = { config: new LocalConfigStore(sourceDirectory), blob: new LocalBlobStore(sourceDirectory), vector: new LocalVectorStore(sourceDirectory) }
  const target = createStorage(process.env)
  assert.deepEqual(target.mode, { blob: 'minio', config: 'postgres', vector: 'milvus' }, '遷移目標必須設定 MinIO、PostgreSQL 與 Milvus')
  let migrationLock
  let journalBase
  try {
    await target.ready
    // A process-wide lock prevents two operators from copying the same source
    // concurrently. The individual adapter writes remain idempotent, but the
    // journal and conflict report must describe one migration at a time.
    migrationLock = await target.config.pool.connect()
    await migrationLock.query("SELECT pg_advisory_lock(hashtext('s2t_local_to_remote_migration'))")
    const previousJournal = apply ? await readJournal() : null
    journalBase = { sourceDirectory, startedAt: new Date().toISOString(), adoptMatchingUsers, mappedScopes: explicitScopeMap.size }
    if (apply) await writeJournal({ ...journalBase, status: 'running', previousRun: previousJournal?.status === 'running' ? { startedAt: previousJournal.startedAt, note: '上一個 apply 未標示完成；本次將以可重跑的保守寫入繼續。' } : undefined })
    await validateExplicitScopeMap(target)
    const { records, userIds } = await migrateConfig(source, target)
    await migrateBlobs(source, target, userIds)
    await migrateVectors(source, target, records, userIds)
    const output = { mode: apply ? 'applied' : 'dry-run', sourceDirectory, ...summary }
    if (apply) await writeJournal({ ...journalBase, status: summary.conflicts.length ? 'completed-with-conflicts' : 'completed', completedAt: new Date().toISOString(), summary: output })
    console.log(JSON.stringify(output, null, 2))
    if (summary.conflicts.length) process.exitCode = 2
  } catch (error) {
    if (apply && journalBase) await writeJournal({ ...journalBase, status: 'failed', failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), summary }).catch(() => undefined)
    throw error
  } finally {
    await migrationLock?.query("SELECT pg_advisory_unlock(hashtext('s2t_local_to_remote_migration'))").catch(() => undefined)
    migrationLock?.release()
    await target.config.pool?.end()
    await target.vector.client?.closeConnection?.()
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
