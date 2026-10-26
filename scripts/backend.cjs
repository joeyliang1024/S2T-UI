const { spawn } = require('node:child_process')
const { root, backendEnv, python } = require('./runtime.cjs')
const args = process.argv.includes('--test') ? ['-m', 'pytest', 'backend/tests', '-q'] : ['-m', 'app']
const child = spawn(python(), args, { cwd: root, env: backendEnv(), stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
