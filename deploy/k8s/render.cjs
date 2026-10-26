const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const render = ({ root, frontend = {}, backend = {}, options = {} }) => {
  const port = (value, fallback) => { const n = Number(value || fallback); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid application port'); return n }
  const frontPort = port(frontend.FRONTEND_PORT, 5173), backPort = port(backend.BACKEND_PORT, 8787)
  const items = JSON.parse(readFileSync(join(root, 'deploy/k8s/web.json'))).items
  const namespace = options.K8S_NAMESPACE || 's2t-web'
  const get = (kind, name) => items.find(x => x.kind === kind && x.metadata.name === name)
  get('ConfigMap', 's2t-backend-env').data.BACKEND_PORT = String(backPort)
  const jargon = get('ConfigMap', 's2t-jargon')
  const jargonFile = options.K8S_JARGON_FILE || join(root, 'data/jargon/jargon_en.csv')
  if (!options.K8S_JARGON_PVC) {
    if (options.K8S_JARGON_FILE && !existsSync(jargonFile)) throw new Error('K8S_JARGON_FILE does not exist')
    if (existsSync(jargonFile)) {
      const csv = readFileSync(jargonFile, 'utf8')
      if (Buffer.byteLength(csv, 'utf8') > 900 * 1024) throw new Error('Jargon CSV exceeds ConfigMap size budget; use K8S_JARGON_PVC')
      jargon.data['jargon_en.csv'] = csv
    }
  }
  Object.assign(get('ConfigMap', 's2t-frontend-env').data, { FRONTEND_PORT: String(frontPort), BACKEND_UPSTREAM: `http://s2t-backend.${namespace}.svc.cluster.local:${backPort}`, DNS_RESOLVER: options.K8S_DNS_RESOLVER || '10.43.0.10' })
  const privateEnv = Object.fromEntries(Object.entries(backend).filter(([key, value]) => /^(S2T_|REDIS_|NODE_ENV$)/.test(key) && value !== ''))
  for (const key of ['S2T_PROCESS_ROLE', 'S2T_KUBERNETES_MODE', 'S2T_STORAGE_MIGRATIONS', 'S2T_MODEL_DIR', 'S2T_DATA_DIR', 'S2T_BIND_HOST', 'S2T_AUDIO_SERVICE_URL']) delete privateEnv[key]
  if (!privateEnv.S2T_AUTH_SECRET || !privateEnv.S2T_POSTGRES_HOST || !privateEnv.S2T_MINIO_ENDPOINT) throw new Error('K8s requires backend auth secret, PostgreSQL and MinIO configuration')
  items.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 's2t-secrets' }, type: 'Opaque', stringData: privateEnv })
  items.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 's2t-frontend-nginx' }, data: { 'default.conf.template': readFileSync(join(root, 'deploy/web/default.conf.template'), 'utf8') } })
  for (const role of ['frontend', 'backend']) {
    const deployment = get('Deployment', `s2t-${role}`), container = deployment.spec.template.spec.containers[0]
    container.image = options[`${role.toUpperCase()}_IMAGE`]
    if (!container.image || /YOUR_REGISTRY|IMMUTABLE_TAG/.test(container.image)) throw new Error(`Configure ${role.toUpperCase()}_IMAGE with a built immutable image`)
    container.imagePullPolicy = options.K8S_IMAGE_PULL_POLICY || 'IfNotPresent'
    container.ports[0].containerPort = role === 'frontend' ? frontPort : backPort
    get('Service', `s2t-${role}`).spec.ports[0].port = role === 'frontend' ? frontPort : backPort
    deployment.spec.template.metadata.annotations = { 's2t/config-sha256': createHash('sha256').update(JSON.stringify([get('ConfigMap', `s2t-${role}-env`).data, role === 'backend' ? [privateEnv, jargon.data] : {}])).digest('hex') }
    if (role === 'backend') {
      const volumes = deployment.spec.template.spec.volumes
      if (options.K8S_MODEL_HOST_PATH) volumes[volumes.findIndex(v => v.name === 'models')] = { name: 'models', hostPath: { path: options.K8S_MODEL_HOST_PATH, type: 'Directory' } }
      if (options.K8S_JARGON_PVC) volumes[volumes.findIndex(v => v.name === 'jargon')] = { name: 'jargon', persistentVolumeClaim: { claimName: options.K8S_JARGON_PVC } }
    }
  }
  for (const item of items) item.metadata.namespace = namespace
  return { apiVersion: 'v1', kind: 'List', items }
}
module.exports = { render }
