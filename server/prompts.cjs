const fs = require('node:fs')
const path = require('node:path')
const defaults = require('../data/prompt/prompts.json')
const { dataPaths, initializeDataFiles } = require('../src/shared/validation/data-paths.cjs')
const catalogs = new Map()
const loadPrompts = (environment = process.env) => {
  const file = path.join(dataPaths(environment).prompt, 'prompts.json')
  if (!catalogs.has(file) || !fs.existsSync(file)) initializeDataFiles(environment)
  // An atomic replacement or in-place edit is visible on the next request.
  // Avoid reseeding directories and parsing unchanged JSON on the hot path.
  const stat = fs.statSync(file, { bigint: true })
  const version = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  const cached = catalogs.get(file)
  if (cached?.version === version) return { ...cached.catalog }
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const key of Object.keys(defaults)) {
    if (typeof catalog[key] !== 'string' || !catalog[key].trim()) throw new Error(`Invalid prompt: ${key}`)
    const required = [...defaults[key].matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1])
    if (required.some(variable => !catalog[key].includes(`{{${variable}}}`))) throw new Error(`Missing prompt variable: ${key}`)
  }
  catalogs.set(file, { version, catalog })
  if (catalogs.size > 16) catalogs.delete(catalogs.keys().next().value)
  return { ...catalog }
}
const renderPrompt = (key, variables = {}, environment) => {
  const value = loadPrompts(environment)[key]
  if (typeof value !== 'string') throw new Error(`Unknown prompt: ${key}`)
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`Missing prompt variable: ${key}.${name}`)
    return String(variables[name])
  })
}
module.exports = { loadPrompts, renderPrompt }
