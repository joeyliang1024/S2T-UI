const { spawnSync } = require('node:child_process')
const { root, readEnv } = require('./runtime.cjs')
const env = { ...readEnv('deploy/compose/.env'), ...readEnv('backend/.env'), ...readEnv('frontend/.env'), ...process.env }
const plugin = spawnSync('docker', ['compose', 'version'], { env, stdio: 'ignore' }).status === 0
const result = spawnSync(plugin ? 'docker' : 'docker-compose', [...(plugin ? ['compose'] : []), '--project-directory', root, '-f', 'deploy/compose/compose.yaml', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exitCode = result.status ?? 1
