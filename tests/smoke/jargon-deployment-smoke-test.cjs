const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { render } = require('../../deploy/k8s/render.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2t-jargon-'))
try {
  for (const name of ['deploy/k8s/web.json', 'deploy/web/default.conf.template']) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.copyFileSync(name, path.join(root, name))
  }
  const backend = { S2T_AUTH_SECRET: 'test', S2T_POSTGRES_HOST: 'postgres', S2T_MINIO_ENDPOINT: 'http://minio:9000' }
  const options = { FRONTEND_IMAGE: 'frontend:test', BACKEND_IMAGE: 'backend:test', K8S_MODEL_HOST_PATH: '/models' }
  const build = extra => render({ root, backend, options: { ...options, ...extra } })
  const get = (manifest, kind, name) => manifest.items.find(x => x.kind === kind && x.metadata.name === name)
  const empty = build()
  assert.deepEqual(get(empty, 'ConfigMap', 's2t-jargon').data, {})
  const file = path.join(root, 'data/jargon/jargon_en.csv')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const csv = 'jargon,az_jargon_listen\nGPU,graphics unit\n'
  fs.writeFileSync(file, csv)
  const first = build()
  assert.equal(get(first, 'ConfigMap', 's2t-jargon').data['jargon_en.csv'], csv)
  const deployment = get(first, 'Deployment', 's2t-backend'), spec = deployment.spec.template.spec
  assert.equal(deployment.spec.replicas, 2)
  assert.deepEqual(spec.volumes.find(v => v.name === 'models').hostPath, { path: '/models', type: 'Directory' })
  assert.equal(spec.volumes.find(v => v.name === 'jargon').configMap.name, 's2t-jargon')
  assert.deepEqual(spec.containers[0].volumeMounts.find(v => v.name === 'jargon'), { name: 'jargon', mountPath: '/data/jargon', readOnly: true })
  fs.writeFileSync(file, csv.replace('graphics unit', 'new translation'))
  assert.notEqual(deployment.spec.template.metadata.annotations['s2t/config-sha256'], get(build(), 'Deployment', 's2t-backend').spec.template.metadata.annotations['s2t/config-sha256'])
  assert.throws(() => build({ K8S_JARGON_FILE: file + '.missing' }), /does not exist/)
  fs.writeFileSync(file, 'a'.repeat(901 * 1024))
  assert.throws(() => build(), /K8S_JARGON_PVC/)
  const pvc = get(build({ K8S_JARGON_PVC: 'shared-jargon' }), 'Deployment', 's2t-backend')
  assert.deepEqual(pvc.spec.template.spec.volumes.find(v => v.name === 'jargon').persistentVolumeClaim, { claimName: 'shared-jargon' })
  console.log('PASS shared jargon ConfigMap, two backend replicas, file updates, preserved model mount and shared PVC override')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
