const { resolveDirectory } = require('../src/shared/validation/directory-path.cjs')

const modelsRoot = (env = process.env, cwd = process.cwd()) => resolveDirectory(env.S2T_MODEL_DIR, 'models', cwd)
module.exports = { modelsRoot }
