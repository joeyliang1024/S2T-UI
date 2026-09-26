const { randomUUID } = require('node:crypto')

const normalizeUsername = (value) => {
  if (typeof value !== 'string') throw new Error('帳號格式不正確')
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw new Error('帳號需為 3 至 64 個英數字、點、底線或連字號')
  return username
}
const userInput = (input) => {
  const username = normalizeUsername(input?.username)
  if (typeof input?.passwordHash !== 'string' || !input.passwordHash) throw new Error('密碼資料無效')
  const NT = typeof input?.NT === 'string' ? input.NT.trim().slice(0, 256) : ''
  const Department = typeof input?.Department === 'string' ? input.Department.trim().slice(0, 256) : ''
  if (!NT || !Department) throw new Error('NT 與 Department 為必填')
  const role = input?.role === 'admin' ? 'admin' : 'user'
  return { id: randomUUID(), username, passwordHash: input.passwordHash, NT, Department, role, createdAt: new Date().toISOString() }
}
const publicUser = ({ id, username, NT, Department, role, createdAt }) => ({ id, username, NT, Department, role: role === 'admin' ? 'admin' : 'user', createdAt })

class LocalUserStore {
  constructor(configStore) { this.config = configStore }
  async create(input) {
    const user = userInput(input); const key = `account-${user.username}`
    if (!await this.config.putIfAbsent('auth', key, user)) throw new Error('帳號已存在')
    return publicUser(user)
  }
  async findByUsername(username) { const user = await this.config.get('auth', `account-${normalizeUsername(username)}`); return user && typeof user === 'object' ? user : null }
  async findById(id) {
    const users = await this.config.list('auth', 'account-')
    return users.map((item) => item.value).find((user) => user && user.id === id) || null
  }
}

class PostgresUserStore {
  constructor(pool) { this.pool = pool }
  async create(input) {
    const user = userInput(input)
    try {
      const result = await this.pool.query('INSERT INTO s2t_users(id, username, password_hash, nt, department, role, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, username, nt AS "NT", department AS "Department", role, created_at AS "createdAt"', [user.id, user.username, user.passwordHash, user.NT, user.Department, user.role, user.createdAt])
      return result.rows[0]
    } catch (error) { if (error && error.code === '23505') throw new Error('帳號已存在'); throw error }
  }
  async findByUsername(username) { const result = await this.pool.query('SELECT id, username, password_hash AS "passwordHash", nt AS "NT", department AS "Department", role, created_at AS "createdAt" FROM s2t_users WHERE username = $1', [normalizeUsername(username)]); return result.rows[0] || null }
  async findById(id) { const result = await this.pool.query('SELECT id, username, password_hash AS "passwordHash", nt AS "NT", department AS "Department", role, created_at AS "createdAt" FROM s2t_users WHERE id = $1', [id]); return result.rows[0] || null }
}

module.exports = { LocalUserStore, PostgresUserStore, normalizeUsername, publicUser }
