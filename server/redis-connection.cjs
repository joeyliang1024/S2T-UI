// Keep Sentinel authentication separate from Redis data-node authentication.
const clientOptions = (env, prefix) => {
  const tls = env[`${prefix}_TLS`]
  if (tls && !['true', 'false'].includes(tls)) throw new Error(`${prefix}_TLS 必須為 true 或 false`)
  return {
    ...(env[`${prefix}_USERNAME`] ? { username: env[`${prefix}_USERNAME`] } : {}),
    ...(env[`${prefix}_PASSWORD`] ? { password: env[`${prefix}_PASSWORD`] } : {}),
    disableOfflineQueue: true, commandsQueueMaxLength: 1000,
    socket: { ...(tls === 'true' ? { tls: true } : {}), connectTimeout: 3000, reconnectStrategy: retries => Math.min(2000, 100 * (retries + 1)) }
  }
}
const redisConnection = env => {
  const nodes = env.S2T_REDIS_SENTINEL_NODES?.trim()
  const name = env.S2T_REDIS_SENTINEL_MASTER_NAME?.trim()
  const sentinelConfigured = Object.keys(env).some(key => key.startsWith('S2T_REDIS_SENTINEL_') && env[key]?.trim())
  if (sentinelConfigured) {
    if (env.S2T_REDIS_URL?.trim()) throw new Error('S2T_REDIS_URL 與 Sentinel 設定不可同時使用')
    if (!nodes || !name) throw new Error('Sentinel 必須設定 S2T_REDIS_SENTINEL_NODES 與 S2T_REDIS_SENTINEL_MASTER_NAME')
    let roots
    try {
      roots = nodes.split(',').map(value => {
        const url = new URL(`redis://${value.trim()}`)
        if (!url.hostname || !url.port || url.username || url.password || url.pathname || url.search || url.hash) throw new Error()
        const port = Number(url.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error()
        return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
      })
    } catch { throw new Error('S2T_REDIS_SENTINEL_NODES 必須為逗號分隔的 host:port 清單') }
    const database = env.S2T_REDIS_DATABASE || '0'
    if (!/^\d+$/.test(database) || !Number.isSafeInteger(Number(database))) throw new Error('S2T_REDIS_DATABASE 必須為非負整數')
    return { mode: 'sentinel', options: {
      name, sentinelRootNodes: roots,
      sentinelClientOptions: { ...clientOptions(env, 'S2T_REDIS_SENTINEL'), socket: { ...clientOptions(env, 'S2T_REDIS_SENTINEL').socket, reconnectStrategy: false } },
      nodeClientOptions: { ...clientOptions(env, 'S2T_REDIS'), socket: { ...clientOptions(env, 'S2T_REDIS').socket, reconnectStrategy: false }, database: Number(database) },
      masterPoolSize: 1, replicaPoolSize: 0, scanInterval: 1000, maxCommandRediscovers: 0
    } }
  }
  if (!env.S2T_REDIS_URL?.trim()) throw new Error('Kubernetes 模式必須設定 S2T_REDIS_URL 或 Sentinel 節點與 master name')
  return { mode: 'url', options: { ...clientOptions({}, 'S2T_REDIS'), url: env.S2T_REDIS_URL } }
}
module.exports = { redisConnection }
