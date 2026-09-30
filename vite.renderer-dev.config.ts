import { resolve } from 'node:path'
import { defineConfig, type ProxyOptions } from 'vite'

/** Renderer-only dev server for UI preview (no Electron shell). */
const apiProxy: ProxyOptions = {
  target: 'http://127.0.0.1:8787',
  changeOrigin: true,
  // The gateway only allows the preview origin (5173); rewrite so the dev
  // server on another port can authenticate through the same proxy.
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', 'http://127.0.0.1:5173'))
  }
}

export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
  server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api': apiProxy } }
})
