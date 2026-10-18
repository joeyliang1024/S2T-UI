const fs = require('node:fs')
const path = require('node:path')
const defaults = require('../data/prompt/prompts.json')
const { initializeDataFiles } = require('../src/shared/validation/data-paths.cjs')
const loadPrompts = (environment = process.env) => {
  const paths = initializeDataFiles(environment)
  const catalog = JSON.parse(fs.readFileSync(path.join(paths.prompt, 'prompts.json'), 'utf8'))
  for (const key of Object.keys(defaults)) {
    if (typeof catalog[key] !== 'string' || !catalog[key].trim()) throw new Error(`Invalid prompt: ${key}`)
    const required = [...defaults[key].matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1])
    if (required.some(variable => !catalog[key].includes(`{{${variable}}}`))) throw new Error(`Missing prompt variable: ${key}`)
  }
  return catalog
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
