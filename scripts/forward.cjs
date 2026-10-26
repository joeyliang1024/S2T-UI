const { spawn } = require('node:child_process')
const { readEnv } = require('./runtime.cjs')
const options = { ...readEnv('deploy/k8s/.env'), ...process.env }
const frontend = { ...readEnv('frontend/.env'), ...process.env }, backend = { ...readEnv('backend/.env'), ...readEnv('backend/.env.k8s'), ...process.env }
const prefix = [...(options.K8S_CONTEXT ? ['--context', options.K8S_CONTEXT] : []), '-n', options.K8S_NAMESPACE || 's2t-web']
const children = new Set(), timers = new Set()
let stopping = false
const stop = code => { if (stopping) return; stopping = true; process.exitCode = code; for (const timer of timers) clearTimeout(timer); for (const child of children) child.kill('SIGTERM') }
const targets = [['s2t-frontend', frontend.FRONTEND_PORT || '5173'], ['s2t-backend', backend.BACKEND_PORT || '8787']]
if (process.argv.includes('--monitoring')) targets.push(['grafana', '3000'], ['prometheus', '9090'])
const forward = (service, port, failures = 0) => {
 if (stopping) return
 const began = Date.now(), child = spawn('kubectl', [...prefix, 'port-forward', `service/${service}`, `${port}:${port}`, '--address=127.0.0.1'], { stdio: 'inherit' }); children.add(child)
 child.on('error', error => { console.error(error.message); stop(1) })
 child.on('exit', () => {
  children.delete(child); if (stopping) return
  const count = Date.now()-began > 30000 ? 0 : failures+1
  if (count > 10) { console.error(`${service} forwarding failed repeatedly`); stop(1); return }
  const timer = setTimeout(() => { timers.delete(timer); forward(service, port, count) }, 1000); timers.add(timer)
 })
}
for (const [service, port] of targets) forward(service, port)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0))
