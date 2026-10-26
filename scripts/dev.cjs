const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { root, readEnv, backendEnv, python } = require('./runtime.cjs')
const back = backendEnv(), front = { ...readEnv('frontend/.env'), ...process.env }
front.S2T_DEV_API_URL ||= `http://127.0.0.1:${back.BACKEND_PORT || 8787}`
const children = []
let stopping = false, exitCode = 0
const stop = (code = 0) => {
  if (stopping) return
  stopping = true; exitCode = code
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  const timer = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL') }, 10000)
  timer.unref()
}
const start = (command, args, env) => {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' }); children.push(child)
  child.on('error', error => { console.error(error.message); stop(1) })
  child.on('exit', (code, signal) => { if (!stopping) stop(code || (signal ? 1 : 0)); if (children.every(c => c.exitCode !== null || c.signalCode !== null)) process.exitCode = exitCode })
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop())
console.log(`Frontend http://127.0.0.1:${front.FRONTEND_PORT || 5173}; backend http://127.0.0.1:${back.BACKEND_PORT || 8787}`)
start(python(), ['-m', 'app'], back)
start(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', 'config/vite.web.config.ts'], front)
