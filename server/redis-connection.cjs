// Keep Sentinel authentication separate from Redis data-node authentication.
const clientOptions = (env, prefix) => {
  const tls = env[`${prefix}_TLS`]
  if (tls && !['true', 'false'].includes(tls)) throw new Error(`${prefix}_TLS 必須為 true 或 false`)
  return {
    ...(env[`${prefix}_USERNAME`] ? { username: env[`${prefix}_USERNAME`] } : { username: 'default' }),
    ...(env[`${prefix}_PASSWARD`] ? { password: env[`${prefix}_PASSWARD`] } : {}),
    disableOfflineQueue: true, commandsQueueMaxLength: 1000,
    socket: { ...(tls === 'true' ? { tls: true } : {}), connectTimeout: 3000, reconnectStrategy: retries => Math.min(2000, 100 * (retries + 1)) }
  }
}
const redisConnection = env => {
  const nodes = env.REDIS_SENTINEL_NODES?.trim()
  const name = env.REDIS_SERVICE_NAME?.trim()
  const sentinelConfigured = Boolean(name) || Object.keys(env).some(key => key.startsWith('REDIS_SENTINEL_') && env[key]?.trim())
  if (sentinelConfigured) {
    if (env.REDIS_URL?.trim()) throw new Error('REDIS_URL 與 Sentinel 設定不可同時使用')
    if (!nodes || !name) throw new Error('Sentinel 必須設定 REDIS_SENTINEL_NODES 與 REDIS_SERVICE_NAME')
    let roots
    try {
      roots = nodes.split(',').map(value => {
        const url = new URL(`redis://${value.trim()}`)
        if (!url.hostname || url.username || url.password || url.pathname || url.search || url.hash) throw new Error()
        const port = Number(url.port || 26379)
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error()
        return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
      })
    } catch { throw new Error('REDIS_SENTINEL_NODES 必須為逗號分隔的 host 或 host:port 清單（預設 26379）') }
    const database = env.REDIS_DATABASE || '0'
    if (!/^\d+$/.test(database) || !Number.isSafeInteger(Number(database))) throw new Error('REDIS_DATABASE 必須為非負整數')
    return { mode: 'sentinel', options: {
      name, sentinelRootNodes: roots,
      sentinelClientOptions: { ...clientOptions(env, 'REDIS_SENTINEL'), socket: { ...clientOptions(env, 'REDIS_SENTINEL').socket, reconnectStrategy: false } },
      nodeClientOptions: { ...clientOptions(env, 'REDIS'), socket: { ...clientOptions(env, 'REDIS').socket, reconnectStrategy: false }, database: Number(database) },
      masterPoolSize: 1, replicaPoolSize: 0, scanInterval: 1000, maxCommandRediscovers: 16
    } }
  }
  if (!env.REDIS_URL?.trim()) throw new Error('Kubernetes 模式必須設定 REDIS_URL 或 Sentinel 節點與 master name')
  const options = clientOptions({}, 'REDIS')
  delete options.username // URL credentials remain authoritative.
  return { mode: 'url', options: { ...options, url: env.REDIS_URL } }
}
module.exports = { redisConnection }
