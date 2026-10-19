const path = require('node:path')
const { resolveDirectory } = require('./directory-path.cjs')
const fs = require('node:fs')
const dataPaths = (environment = process.env) => {
  const root = resolveDirectory(environment.S2T_DATA_DIR, '.s2t-data')
  return { root, prompt: path.join(root, 'prompt'), template: path.join(root, 'template') }
}
const initializeDataFiles = (environment = process.env, defaults = path.resolve(__dirname, '../../../data')) => {
  const paths = dataPaths(environment)
  for (const kind of ['prompt', 'template']) {
    fs.mkdirSync(paths[kind], { recursive: true })
    const source = path.join(defaults, kind)
    if (!fs.existsSync(source) || path.resolve(source) === paths[kind]) continue
    if (kind === 'template' && fs.readdirSync(paths[kind]).some(name => /\.(md|markdown)$/i.test(name))) continue
    for (const name of fs.readdirSync(source)) {
      if (!/\.(json|md|markdown)$/i.test(name) || !fs.statSync(path.join(source, name)).isFile()) continue
      const destination = path.join(paths[kind], name)
      // Read-only ConfigMap/template mounts are valid if the file exists already.
      if (!fs.existsSync(destination)) {
        try { fs.copyFileSync(path.join(source, name), destination, fs.constants.COPYFILE_EXCL) }
        catch (error) { if (error.code !== 'EEXIST') throw error }
      }
    }
  }
  return paths
}
module.exports = { dataPaths, initializeDataFiles }
