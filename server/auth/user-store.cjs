const { randomUUID, createHash } = require('node:crypto')
const { writer } = require('../storage/request-batches.cjs')

const normalizeUsername = (value) => {
  if (typeof value !== 'string') throw new Error('帳號格式不正確')
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw new Error('帳號需為 3 至 64 個英數字、點、底線或連字號')
  return username
}
// NT is the company-wide identity.  Preserve the entered spelling for display,
// while using a stable case-insensitive key when checking uniqueness.
const normalizeNT = (value) => {
  if (typeof value !== 'string') throw new Error('NT 格式不正確')
  const NT = value.trim().slice(0, 256)
  if (!NT) throw new Error('NT 與 Department 為必填')
  return NT
}
const ntKey = (NT) => normalizeNT(NT).toLocaleLowerCase('en-US')
// Record keys must satisfy the storage key charset, but NT is free text
// (company identities contain spaces and CJK characters). Reserve a hash of
// the normalised NT instead; duplicate detection for already stored accounts
// is still done by scanning the account records in create() below.
const ntReservationKey = (NT) => `nt-${createHash('sha256').update(ntKey(NT)).digest('hex').slice(0, 40)}`
const userInput = (input) => {
  const username = normalizeUsername(input?.username)
  if (typeof input?.passwordHash !== 'string' || !input.passwordHash) throw new Error('密碼資料無效')
  const NT = normalizeNT(input?.NT)
  const Department = typeof input?.Department === 'string' ? input.Department.trim().slice(0, 256) : ''
  if (!NT || !Department) throw new Error('NT 與 Department 為必填')
  const role = input?.role ?? 'user'
  if (!['admin', 'developer', 'user'].includes(role)) throw accountError('角色無效', 400)
  return { id: randomUUID(), username, passwordHash: input.passwordHash, NT, Department, role, createdAt: new Date().toISOString() }
}
const publicUser = ({ id, username, NT, Department, role, createdAt, deletionState }) => ({ id, username, NT, Department, role: ['admin', 'developer'].includes(role) ? role : 'user', createdAt, ...(deletionState === 'deleting' ? { deletionState: 'deleting' } : {}) })
const userId = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('帳號識別碼無效')
  return value
}
const accountError = (message, status) => Object.assign(new Error(message), { status })

class LocalUserStore {
  constructor(configStore) { this.config = configStore }
  async create(input) {
    const user = userInput(input); const key = `account-${user.username}`
    // Old local stores do not have NT reservation records. Check those entries
    // before reserving, then use putIfAbsent to serialize concurrent signups.
    const existing = await this.config.list('auth', 'account-')
    if (existing.some((item) => item.value && typeof item.value.NT === 'string' && ntKey(item.value.NT) === ntKey(user.NT))) throw new Error('NT 已存在')
    const reservation = ntReservationKey(user.NT)
    if (!await this.config.putIfAbsent('auth', reservation, user.id)) throw new Error('NT 已存在')
    try {
      if (user.role === 'admin' && !await this.config.putIfAbsent('auth', 'singleton-admin', user.id)) throw accountError('admin 帳號只能有一個', 409)
      try {
        if (!await this.config.putIfAbsent('auth', key, user)) throw new Error('帳號已存在')
      } catch (error) {
        if (user.role === 'admin') await this.config.remove('auth', 'singleton-admin')
        throw error
      }
    } catch (error) {
      await this.config.remove('auth', reservation)
      throw error
    }
    return publicUser(user)
  }
  async list() { return (await this.config.list('auth', 'account-')).map(item => item.value).filter(Boolean).map(publicUser).sort((a,b) => a.username.localeCompare(b.username)).slice(0, 1000) }
  async findAdmin() {
    const accounts = await this.config.list('auth', 'account-')
    return accounts.map(entry => entry.value).filter(user => user?.role === 'admin' && user.deletionState !== 'deleting').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.id.localeCompare(b.id))[0] || null
  }
  async findByUsername(username) { const user = await this.config.get('auth', `account-${normalizeUsername(username)}`); return user && typeof user === 'object' ? user : null }
  async findById(id) {
    const users = await this.config.list('auth', 'account-')
    return users.map((item) => item.value).find((user) => user && user.id === id) || null
  }
  async ensureSingleAdmin() {
    const owner = await this.config.updateAuthAccounts(accounts => {
      const admins = accounts.filter(entry => entry.value.role === 'admin' && entry.value.deletionState !== 'deleting').sort((a, b) => new Date(a.value.createdAt) - new Date(b.value.createdAt) || a.value.id.localeCompare(b.value.id))
      for (const entry of admins.slice(1)) entry.value.role = 'developer'
      return admins[0]?.value.id || null
    })
    if (owner) await this.config.put('auth', 'singleton-admin', owner)
  }
  async setRole(id, role, actorId) {
    if (!['developer', 'user'].includes(role)) throw accountError('只能設定 developer 或 user；admin 帳號唯一', 400)
    const targetId = userId(id), actor = userId(actorId)
    return this.config.updateAuthAccounts(accounts => {
      const admin = accounts.find(entry => entry.value.id === actor)?.value
      if (admin?.role !== 'admin' || admin.deletionState === 'deleting') throw accountError('只有 admin 可管理帳號', 403)
      const target = accounts.find(entry => entry.value.id === targetId)?.value
      if (!target) throw accountError('找不到帳號', 404)
      if (target.role === 'admin' || targetId === actor) throw accountError('不能變更唯一 admin 的權限', 409)
      if (target.deletionState === 'deleting') throw accountError('帳號刪除中，無法變更權限', 409)
      target.role = role
      return publicUser(target)
    })
  }
  async markDeleting(id, actorId) {
    const targetId = userId(id); const actor = userId(actorId)
    return this.config.updateAuthAccounts((accounts) => {
      const actorAccount = accounts.find((entry) => entry.value?.id === actor)?.value
      if (!actorAccount || actorAccount.role !== 'admin' || actorAccount.deletionState === 'deleting') throw accountError('管理者帳號已不可用', 403)
      const target = accounts.find((entry) => entry.value?.id === targetId)
      if (!target) return null
      if (targetId === actor) throw accountError('不能刪除目前登入的帳號', 409)
      if (target.value.deletionState === 'deleting') return publicUser(target.value)
      if (target.value.role === 'admin' && accounts.filter((entry) => entry.value?.role === 'admin' && entry.value.deletionState !== 'deleting').length <= 1) throw accountError('至少必須保留一個 admin 帳號', 409)
      target.value.deletionState = 'deleting'
      return publicUser(target.value)
    })
  }
  async remove(id) {
    const target = await this.findById(userId(id))
    return target ? this.config.removeAuthAccount(target.id, ntReservationKey(target.NT)) : false
  }
}

class PostgresUserStore {
  constructor(pool) {
    this.pool = pool
    this.sessionReads = writer(async entries => {
      const unique = [...new Map(entries.map(x => [JSON.stringify(x), x])).values()]
      const result = await pool.query(`SELECT users.id, users.username, users.nt AS "NT", users.department AS "Department", users.role,
        users.created_at AS "createdAt", users.deletion_state AS "deletionState", records.value AS revocations, input."revokedKey"
        FROM jsonb_to_recordset($1::jsonb) AS input(id text,"revokedKey" text)
        JOIN s2t_users users ON users.id=input.id
        LEFT JOIN s2t_config_records records ON records.scope=users.id AND records.record_key=input."revokedKey"`, [JSON.stringify(unique)])
      const found = new Map(result.rows.map(row => [JSON.stringify([row.id,row.revokedKey]),row]))
      return entries.map(x => found.get(JSON.stringify([x.id,x.revokedKey])) || null)
    })
  }
  async create(input) {
    const user = userInput(input)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (user.role === 'admin') {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('s2t_users_single_admin'))")
        if ((await client.query("SELECT id FROM s2t_users WHERE role = 'admin' LIMIT 1")).rowCount) throw accountError('admin 帳號只能有一個', 409)
      }
      const result = await client.query('INSERT INTO s2t_users(id, username, password_hash, nt, department, role, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, username, nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState"', [user.id, user.username, user.passwordHash, user.NT, user.Department, user.role, user.createdAt])
      await client.query('COMMIT')
      return result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (error && error.code === '23505') throw new Error(String(error.constraint || '').includes('nt_unique') ? 'NT 已存在' : '帳號已存在')
      throw error
    } finally { client.release() }
  }
  async ensureSingleAdmin() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('s2t_users_single_admin'))")
      await client.query("UPDATE s2t_users SET role = 'developer', updated_at = NOW() WHERE role = 'admin' AND id <> (SELECT id FROM s2t_users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1)")
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS s2t_users_single_admin_index ON s2t_users (role) WHERE role = 'admin'")
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  }
  async setRole(id, role, actorId) {
    if (!['developer', 'user'].includes(role)) throw accountError('只能設定 developer 或 user；admin 帳號唯一', 400)
    const targetId = userId(id), actor = userId(actorId), client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const accounts = await client.query('SELECT id, role, deletion_state FROM s2t_users WHERE id = $1 OR id = $2 ORDER BY id FOR UPDATE', [targetId, actor])
      const admin = accounts.rows.find(row => row.id === actor)
      if (admin?.role !== 'admin' || admin.deletion_state === 'deleting') throw accountError('只有 admin 可管理帳號', 403)
      const target = accounts.rows.find(row => row.id === targetId)
      if (!target) throw accountError('找不到帳號', 404)
      if (target.role === 'admin' || targetId === actor) throw accountError('不能變更唯一 admin 的權限', 409)
      if (target.deletion_state === 'deleting') throw accountError('帳號刪除中，無法變更權限', 409)
      const changed = await client.query('UPDATE s2t_users SET role = $2, updated_at = NOW() WHERE id = $1 RETURNING id, username, nt AS "NT", department AS "Department", role, created_at AS "createdAt"', [targetId, role])
      await client.query('COMMIT')
      return publicUser(changed.rows[0])
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  }

  async list() { const result = await this.pool.query('SELECT id, username, nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState" FROM s2t_users ORDER BY username LIMIT 1000'); return result.rows.map(publicUser) }
  async findAdmin() {
    const result = await this.pool.query("SELECT id FROM s2t_users WHERE role = 'admin' AND deletion_state <> 'deleting' ORDER BY created_at, id LIMIT 1")
    return result.rows[0] || null
  }
  async findByUsername(username) { const result = await this.pool.query('SELECT id, username, password_hash AS "passwordHash", nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState" FROM s2t_users WHERE username = $1', [normalizeUsername(username)]); return result.rows[0] || null }
  async findSessionUser(id, revokedKey) {
    return this.sessionReads.request({ id: userId(id), revokedKey })
  }
  async findById(id) { const result = await this.pool.query('SELECT id, username, password_hash AS "passwordHash", nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState" FROM s2t_users WHERE id = $1', [userId(id)]); return result.rows[0] || null }
  async markDeleting(id, actorId) {
    const targetId = userId(id); const actor = userId(actorId); const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('s2t_users_admin_deletion'))")
      const users = await client.query('SELECT id, username, nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState" FROM s2t_users WHERE id = $1 OR id = $2 FOR UPDATE', [targetId, actor])
      const actorAccount = users.rows.find((row) => row.id === actor)
      if (!actorAccount || actorAccount.role !== 'admin' || actorAccount.deletionState === 'deleting') throw accountError('管理者帳號已不可用', 403)
      const target = users.rows.find((row) => row.id === targetId)
      if (!target) { await client.query('COMMIT'); return null }
      if (targetId === actor) throw accountError('不能刪除目前登入的帳號', 409)
      if (target.deletionState === 'deleting') { await client.query('COMMIT'); return publicUser(target) }
      if (target.role === 'admin') {
        const admins = await client.query("SELECT id FROM s2t_users WHERE role = 'admin' AND deletion_state <> 'deleting' FOR UPDATE")
        if (admins.rowCount <= 1) throw accountError('至少必須保留一個 admin 帳號', 409)
      }
      const changed = await client.query("UPDATE s2t_users SET deletion_state = 'deleting', updated_at = NOW() WHERE id = $1 RETURNING id, username, nt AS \"NT\", department AS \"Department\", role, created_at AS \"createdAt\", deletion_state AS \"deletionState\"", [targetId])
      await client.query('COMMIT')
      return publicUser(changed.rows[0])
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  }
  async remove(id) { const result = await this.pool.query("DELETE FROM s2t_users WHERE id = $1 AND deletion_state = 'deleting'", [userId(id)]); return result.rowCount === 1 }
}

module.exports = { LocalUserStore, PostgresUserStore, normalizeUsername, normalizeNT, publicUser }
