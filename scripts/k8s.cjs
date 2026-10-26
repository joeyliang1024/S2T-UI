const { spawnSync } = require('node:child_process')
const { root, readEnv } = require('./runtime.cjs')
const { render } = require('../deploy/k8s/render.cjs')
const frontend = { ...readEnv('frontend/.env'), ...(process.env.FRONTEND_PORT ? { FRONTEND_PORT: process.env.FRONTEND_PORT } : {}) }
const backend = { ...readEnv('backend/.env'), ...readEnv('backend/.env.k8s') }
if (process.env.BACKEND_PORT) backend.BACKEND_PORT = process.env.BACKEND_PORT
const options = { ...readEnv('deploy/k8s/.env'), ...process.env }
const manifest = render({ root, frontend, backend, options })
const namespace = options.K8S_NAMESPACE || 's2t-web'
const prefix = [...(options.K8S_CONTEXT ? ['--context', options.K8S_CONTEXT] : []), '-n', namespace]
const run = (args, input) => { const r = spawnSync('kubectl', [...prefix, ...args], { cwd: root, input: input && JSON.stringify(input), stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'] }); if (r.status !== 0) process.exit(r.status || 1) }
const action = process.argv[2] || 'up'
if (action === 'up') {
  run(['apply', '-f', '-'], { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } })
  run(['apply', '-f', '-'], { ...manifest, items: manifest.items.filter(x => !['Deployment', 'Service', 'PodDisruptionBudget'].includes(x.kind)) })
  const backendDeployment = manifest.items.find(x => x.kind === 'Deployment' && x.metadata.name === 's2t-backend')
  const job = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: `s2t-migrate-${Date.now()}`, namespace }, spec: { ttlSecondsAfterFinished: 60, activeDeadlineSeconds: 300, backoffLimit: 1, template: { spec: { restartPolicy: 'Never', containers: [{ name: 'migrate', image: backendDeployment.spec.template.spec.containers[0].image, imagePullPolicy: backendDeployment.spec.template.spec.containers[0].imagePullPolicy, command: ['python', '-m', 'app.migrate'], envFrom: [{ secretRef: { name: 's2t-secrets' } }] }] } } } }
  run(['apply', '-f', '-'], job)
  run(['wait', '--for=condition=complete', `job/${job.metadata.name}`, '--timeout=300s'])
  run(['apply', '-f', '-'], manifest)
  for (const name of ['s2t-backend', 's2t-frontend']) run(['rollout', 'status', `deployment/${name}`, '--timeout=300s'])
} else if (action === 'down') {
  // Remove application workloads only. Storage, secrets, and monitoring survive.
  run(['delete', 'deployment/s2t-frontend', 'deployment/s2t-backend', 'service/s2t-frontend', 'service/s2t-backend', 'pdb/s2t-backend', '--ignore-not-found'])
} else throw new Error(`Unknown K8s action: ${action}`)
