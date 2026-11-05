import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Web mode, browser half: the same renderer as the desktop app, entered through
// web.html (HTTP transport instead of the Electron preload).
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'out/web/client'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/web.html') }
  }
})
