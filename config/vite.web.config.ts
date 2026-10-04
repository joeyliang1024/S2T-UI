import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(process.cwd(), 'src/renderer'),
  resolve: { alias: { '@renderer': resolve(process.cwd(), 'src/renderer/src') } },
  build: { outDir: resolve(process.cwd(), 'out/renderer'), emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 4173, proxy: { '/api': 'http://127.0.0.1:8787' } }
})
