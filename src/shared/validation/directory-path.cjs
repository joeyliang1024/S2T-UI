const { resolve, join } = require('node:path')
const { homedir } = require('node:os')

// Resolve both roots consistently, including shell-style home paths from .env.
const resolveDirectory = (value, fallback, cwd = process.cwd()) => {
  const directory = value?.trim() || fallback
  const expanded = directory === '~' ? homedir() : /^~[\\/]/.test(directory) ? join(homedir(), directory.slice(2)) : directory
  return resolve(cwd, expanded)
}
module.exports = { resolveDirectory }
