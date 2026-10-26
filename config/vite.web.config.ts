import { defineConfig, loadEnv } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const browserValidators = ['admin-parameters', 'remote-session-payload']

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, resolve(process.cwd(), 'frontend'), ''), ...process.env }
  const port = Number(env.FRONTEND_PORT || 5173)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FRONTEND_PORT')
  return {
  root: resolve(process.cwd(), 'frontend'),
  envDir: resolve(process.cwd(), 'frontend'),
  resolve: { alias: { '@renderer': resolve(process.cwd(), 'frontend/src') } },
  // Keep one validator source for desktop/tests while exposing native ESM to
  // browsers. These two modules have no require() or other CJS side effects.
  plugins: [{
    name: 'browser-shared-validators',
    enforce: 'pre',
    resolveId(source) {
      const name = browserValidators.find(name => source.split('?')[0].endsWith(`/validation/${name}.cjs`))
      if (name) return `\0browser-validator:${name}`
    },
    load(id) {
      if (!id.startsWith('\0browser-validator:')) return
      const name = id.slice('\0browser-validator:'.length)
      if (!browserValidators.includes(name)) throw new Error('Unknown browser validator')
      const source = readFileSync(resolve(process.cwd(), `frontend/shared/validation/${name}.cjs`), 'utf8')
      return source.replace(/module\.exports\s*=\s*\{([^}]+)\}/, 'export { $1 }')
    },
    transform(source, id) {
      if (browserValidators.some(name => id.split('?')[0].endsWith(`/validation/${name}.cjs`))) {
        return source.replace(/module\.exports\s*=\s*\{([^}]+)\}/, 'export { $1 }')
      }
    }
  }],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: { '/api': { target: env.S2T_DEV_API_URL || 'http://127.0.0.1:8787', changeOrigin: false } }
  },
  preview: { port, strictPort: true },
  build: { outDir: resolve(process.cwd(), 'out/web'), emptyOutDir: true }
}
})
