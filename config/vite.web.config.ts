import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(process.cwd(), 'src/renderer'),
  resolve: { alias: { '@renderer': resolve(process.cwd(), 'src/renderer/src') } },
  build: { outDir: resolve(process.cwd(), 'out/web'), emptyOutDir: true }
})
