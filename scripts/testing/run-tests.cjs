const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const suites = require('../../tests/suites.json')
const group = process.argv[2] || 'unit'
if (!suites[group]) throw new Error(`Unknown test suite: ${group}`)
if (group === 'external' && process.env.S2T_ALLOW_EXTERNAL_TESTS !== 'true') throw new Error('External tests can clear data or stop containers. Use an isolated environment and explicitly set S2T_ALLOW_EXTERNAL_TESTS=true.')
const root = resolve(__dirname, '../..')
const cleanEnv = group === 'external' ? process.env : Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('S2T_') && !key.startsWith('REDIS_')))
for (const key of ['S2T_BROWSER_EXECUTABLE', 'S2T_PYTHON_EXECUTABLE', 'S2T_TEST_WEB_URL']) if (process.env[key]) cleanEnv[key] = process.env[key]
let failed = 0
for (const file of suites[group]) {
  console.log(`\n[${group}] ${file}`)
  const result = spawnSync(process.execPath, [resolve(root, 'tests/smoke', file)], { cwd: root, env: cleanEnv, stdio: 'inherit', timeout: 120000 })
  if (result.status !== 0) { failed++; console.error(result.error?.message || `Exit: ${result.status}`) }
}
console.log(`\n${group}: ${suites[group].length - failed}/${suites[group].length} passed`)
process.exitCode = failed ? 1 : 0
