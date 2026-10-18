// TypeScript 7 is a native checker and no longer supplies the JavaScript
// compiler API. Test snippets use the project's supported esbuild transform.
module.exports = source => require('esbuild').transformSync(source, { loader: 'ts', target: 'es2022', format: 'cjs' })
