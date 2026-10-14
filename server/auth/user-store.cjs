const { randomUUID, createHash } = require('node:crypto')

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
  const role = input?.role === 'admin' ? 'admin' : 'user'
  return { id: randomUUID(), username, passwordHash: input.passwordHash, NT, Department, role, createdAt: new Date().toISOString() }
}
const publicUser = ({ id, username, NT, Department, role, createdAt, deletionState }) => ({ id, username, NT, Department, role: role === 'admin' ? 'admin' : 'user', createdAt, ...(deletionState === 'deleting' ? { deletionState: 'deleting' } : {}) })
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
      if (!await this.config.putIfAbsent('auth', key, user)) throw new Error('帳號已存在')
    } catch (error) {
      await this.config.remove('auth', reservation)
      throw error
    }
    return publicUser(user)
  }
  async list() { return (await this.config.list('auth', 'account-')).map(item => item.value).filter(Boolean).map(publicUser).sort((a,b) => a.username.localeCompare(b.username)).slice(0, 1000) }
  async findByUsername(username) { const user = await this.config.get('auth', `account-${normalizeUsername(username)}`); return user && typeof user === 'object' ? user : null }
  async findById(id) {
    const users = await this.config.list('auth', 'account-')
    return users.map((item) => item.value).find((user) => user && user.id === id) || null
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
  constructor(pool) { this.pool = pool }
  async create(input) {
    const user = userInput(input)
    try {
      const result = await this.pool.query('INSERT INTO s2t_users(id, username, password_hash, nt, department, role, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, username, nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState"', [user.id, user.username, user.passwordHash, user.NT, user.Department, user.role, user.createdAt])
      return result.rows[0]
    } catch (error) {
      if (error && error.code === '23505') throw new Error(String(error.constraint || '').includes('nt_unique') ? 'NT 已存在' : '帳號已存在')
      throw error
    }
  }
  async list() { const result = await this.pool.query('SELECT id, username, nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState" FROM s2t_users ORDER BY username LIMIT 1000'); return result.rows.map(publicUser) }
  async findByUsername(username) { const result = await this.pool.query('SELECT id, username, password_hash AS "passwordHash", nt AS "NT", department AS "Department", role, created_at AS "createdAt", deletion_state AS "deletionState" FROM s2t_users WHERE username = $1', [normalizeUsername(username)]); return result.rows[0] || null }
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
