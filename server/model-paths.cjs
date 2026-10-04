const { resolve } = require('node:path')

// All bundled models and platform runtimes share one mount/root. Relative
// values resolve from the application working directory, like the defaults.
const modelsRoot = (env = process.env, cwd = process.cwd()) => resolve(cwd, env.S2T_MODELS_DIR?.trim() || 'models')
module.exports = { modelsRoot }
