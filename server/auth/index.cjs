const { randomBytes } = require('node:crypto')
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { LocalUserStore, PostgresUserStore, normalizeUsername, publicUser } = require('./user-store.cjs')

const readJson = async (request, maximum = 64 * 1024) => {
  let bytes = 0; const chunks = []
  for await (const chunk of request) { bytes += chunk.length; if (bytes > maximum) throw new Error('請求內容過大'); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('請求格式必須是 JSON') }
}
const localSecret = async (directory) => {
  const file = join(directory, 'auth-secret')
  try { return (await readFile(file, 'utf8')).trim() } catch {
    await mkdir(directory, { recursive: true }); const secret = randomBytes(48).toString('base64url'); const temporary = `${file}.tmp`
    await writeFile(temporary, secret, { mode: 0o600 }); await rename(temporary, file); return secret
  }
}
const createAuth = async (storage, environment = process.env) => {
  const users = storage.mode.config === 'postgres' ? new PostgresUserStore(storage.config.pool) : new LocalUserStore(storage.config)
  const secret = environment.S2T_AUTH_SECRET?.trim() || await localSecret(environment.S2T_LOCAL_DATA_DIR || join(process.cwd(), '.s2t-data'))
  const issue = (user) => jwt.sign({ sub: user.id }, secret, { algorithm: 'HS256', expiresIn: '7d' })
  const ensureBootstrapAdmin = async () => {
    const username = environment.S2T_BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin'
    const password = environment.S2T_BOOTSTRAP_ADMIN_PASSWORD?.trim() || 'admin'
    if (await users.findByUsername(username)) return
    try { await users.create({ username, passwordHash: await bcrypt.hash(password, 12), NT: username, Department: 'admin', role: 'admin' }) } catch (error) { if (!(error instanceof Error) || error.message !== '帳號已存在') throw error }
  }
  await ensureBootstrapAdmin()
  return {
    async register(input) {
      const password = typeof input?.password === 'string' ? input.password : ''
      if (!password) throw new Error('密碼為必填')
      const user = await users.create({ username: input.username, passwordHash: await bcrypt.hash(password, 12), NT: input.NT, Department: input.Department })
      return { user, token: issue(user) }
    },
    async login(input) {
      const account = await users.findByUsername(normalizeUsername(input?.username))
      if (!account || !await bcrypt.compare(typeof input?.password === 'string' ? input.password : '', account.passwordHash)) throw new Error('帳號或密碼錯誤')
      const user = publicUser(account); return { user, token: issue(user) }
    },
    async session(token) {
      try { const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }); if (!payload || typeof payload === 'string' || typeof payload.sub !== 'string') return null; const user = await users.findById(payload.sub); return user ? publicUser(user) : null } catch { return null }
    },
    async requireUser(request) {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
      return this.session(token)
    },
    async handle(request, response, send) {
      const url = new URL(request.url, 'http://localhost').pathname
      if (request.method === 'POST' && url === '/api/auth/register') {
        try { send(response, 201, await this.register(await readJson(request))) } catch (error) { send(response, error instanceof Error && error.message === '帳號已存在' ? 409 : 400, { error: error instanceof Error ? error.message : '註冊失敗' }) }; return true
      }
      if (request.method === 'POST' && url === '/api/auth/login') {
        try { send(response, 200, await this.login(await readJson(request))) } catch (error) { send(response, 401, { error: error instanceof Error ? error.message : '登入失敗' }) }; return true
      }
      if (request.method === 'GET' && url === '/api/auth/session') {
        const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') || ''; const user = await this.session(token)
        send(response, user ? 200 : 401, user ? { user } : { error: '登入狀態已失效' }); return true
      }
      if (request.method === 'POST' && url === '/api/auth/logout') { send(response, 204, ''); return true }
      return false
    }
  }
}

module.exports = { createAuth }
