// Local evaluation bridge: use the exact production cleanup and loop guard.
const { buildSync } = require('esbuild')
const { createInterface } = require('node:readline')
const result = buildSync({ entryPoints: ['frontend/src/features/models/domain/asr-text.ts'], bundle:true, platform:'node', format:'cjs', write:false })
const loaded = new module.constructor('asr-filter')
loaded.paths = module.paths
loaded._compile(result.outputFiles[0].text, 'asr-filter.cjs')
const { sanitizeAsrText, isRepetitiveAsrText } = loaded.exports
createInterface({ input:process.stdin }).on('line', line => {
  const text = sanitizeAsrText(JSON.parse(line))
  process.stdout.write(JSON.stringify(isRepetitiveAsrText(text) ? '' : text)+'\n')
})
