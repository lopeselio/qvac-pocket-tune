import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run dev` serves the UI with hot reload and forwards /api to a running
// `pocket-tune ui` (default port 4322). changeOrigin rewrites the Host header,
// which the API server checks.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:4322', changeOrigin: true } }
  }
})
