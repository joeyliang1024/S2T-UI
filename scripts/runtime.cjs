const { existsSync, readFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { parse } = require('dotenv')
const root = resolve(__dirname, '..')
const readEnv = (name) => {
  const file = join(root, name)
  return existsSync(file) ? parse(readFileSync(file)) : {}
}
const backendEnv = () => ({ ...readEnv('backend/.env'), ...process.env, PYTHONPATH: join(root, 'backend') })
const python = () => process.env.S2T_PYTHON_EXECUTABLE || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : process.platform === 'win32' && existsSync(join(root, '.venv/Scripts/python.exe')) ? join(root, '.venv/Scripts/python.exe') : 'python3')
module.exports = { root, readEnv, backendEnv, python }
