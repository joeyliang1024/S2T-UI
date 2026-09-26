import { defineConfig } from 'vite'

/** Browser-only preview: serves the built renderer and forwards API calls to the local gateway. */
export default defineConfig({
  preview: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } }
})
