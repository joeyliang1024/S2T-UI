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
  const configuredSecret = environment.S2T_AUTH_SECRET?.trim()
  if (environment.S2T_KUBERNETES_MODE === 'true' && !configuredSecret) throw new Error('Kubernetes 模式必須設定所有 Pod 共用的 S2T_AUTH_SECRET')
  const secret = configuredSecret || await localSecret(environment.S2T_LOCAL_DATA_DIR || join(process.cwd(), '.s2t-data'))
  const revokedTokensKey = 'revoked-auth-tokens'
  const requestToken = (request) => {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (bearer) return bearer
    const cookie = request.headers.cookie || ''
    return /(?:^|;\s*)s2t_auth=([^;]+)/.exec(cookie)?.[1] || ''
  }
  const cookieSameSite = environment.S2T_COOKIE_SAME_SITE === 'none' ? 'None' : 'Strict'
  if (cookieSameSite === 'None' && environment.S2T_COOKIE_SECURE !== 'true') throw new Error('S2T_COOKIE_SAME_SITE=none 必須同時設定 S2T_COOKIE_SECURE=true')
  const setSessionCookie = (response, token) => response.setHeader('set-cookie', `s2t_auth=${token}; Path=/; HttpOnly; SameSite=${cookieSameSite}; Max-Age=604800${environment.S2T_COOKIE_SECURE === 'true' ? '; Secure' : ''}`)
  const issue = (user) => jwt.sign({ sub: user.id }, secret, { algorithm: 'HS256', expiresIn: '7d', jwtid: randomBytes(18).toString('base64url') })
  const failedLogins = new Map()
  const loginWindowMs = 15 * 60_000
  const maximumLoginFailures = 8
  const loginKey = (request, input) => `${request.socket.remoteAddress || 'unknown'}:${typeof input?.username === 'string' ? input.username.trim().toLowerCase().slice(0, 64) : ''}`
  const recentFailures = (key) => {
    const now = Date.now()
    const recent = (failedLogins.get(key) || []).filter((time) => now - time < loginWindowMs)
    if (recent.length) failedLogins.set(key, recent); else failedLogins.delete(key)
    return recent
  }
  const ensureBootstrapAdmin = async () => {
    // Environment values define the initial user. Later users can always
    // register independently; if a matching account already exists it is
    // intentionally left unchanged.
    const username = environment.S2T_BOOTSTRAP_ADMIN_USERNAME?.trim() || 'admin'
    const password = environment.S2T_BOOTSTRAP_ADMIN_PASSWORD?.trim() || 'admin'
    if (await users.findByUsername(username)) return
    try { await users.create({ username, passwordHash: await bcrypt.hash(password, 12), NT: username, Department: 'admin', role: 'admin' }) } catch (error) { if (!(error instanceof Error) || error.message !== '帳號已存在') throw error }
  }
  await ensureBootstrapAdmin()
  const activeRevocations = async (userId) => {
    const now = Math.floor(Date.now() / 1000)
    const stored = await storage.config.get(userId, revokedTokensKey)
    const active = Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.jti === 'string' && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > now) : []
    if (active.length !== (Array.isArray(stored) ? stored.length : 0)) await storage.config.put(userId, revokedTokensKey, active)
    return active
  }
  return {
    // Kept server-side only.  The gateway derives per-account encrypted
    // credential storage from the same durable secret used for sessions.
    secret,
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
      try {
        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
        if (!payload || typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null
        const user = await users.findById(payload.sub)
        if (!user || (await activeRevocations(user.id)).some((entry) => entry.jti === payload.jti)) return null
        return publicUser(user)
      } catch { return null }
    },
    async revoke(token) {
      try {
        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
        if (!payload || typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || !Number.isSafeInteger(payload.exp)) return
        const entries = await activeRevocations(payload.sub)
        if (!entries.some((entry) => entry.jti === payload.jti)) await storage.config.put(payload.sub, revokedTokensKey, [...entries, { jti: payload.jti, expiresAt: payload.exp }])
      } catch { /* An expired or invalid token is already unusable. */ }
    },
    async requireUser(request) {
      return this.session(requestToken(request))
    },
    async handle(request, response, send) {
      const url = new URL(request.url, 'http://localhost').pathname
      if (request.method === 'POST' && url === '/api/auth/register') {
        try { const result = await this.register(await readJson(request)); setSessionCookie(response, result.token); send(response, 201, result) } catch (error) { send(response, error instanceof Error && (error.message === '帳號已存在' || error.message === 'NT 已存在') ? 409 : 400, { error: error instanceof Error ? error.message : '註冊失敗' }) }; return true
      }
      if (request.method === 'POST' && url === '/api/auth/login') {
        let input
        try { input = await readJson(request) } catch (error) { send(response, 400, { error: error instanceof Error ? error.message : '登入格式錯誤' }); return true }
        const key = loginKey(request, input)
        if (recentFailures(key).length >= maximumLoginFailures) { send(response, 429, { error: '登入失敗次數過多，請 15 分鐘後再試。' }); return true }
        try {
          const result = await this.login(input)
          failedLogins.delete(key)
          setSessionCookie(response, result.token)
          send(response, 200, result)
        } catch (error) {
          const failures = recentFailures(key); failures.push(Date.now()); failedLogins.set(key, failures)
          send(response, 401, { error: error instanceof Error ? error.message : '登入失敗' })
        }
        return true
      }
      if (request.method === 'GET' && url === '/api/auth/session') {
        const user = await this.session(requestToken(request))
        send(response, user ? 200 : 401, user ? { user } : { error: '登入狀態已失效' }); return true
      }
      if (request.method === 'POST' && url === '/api/auth/logout') {
        const token = requestToken(request)
        await this.revoke(token)
        response.setHeader('set-cookie', 's2t_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
        send(response, 204, ''); return true
      }
      return false
    }
  }
}

module.exports = { createAuth }
