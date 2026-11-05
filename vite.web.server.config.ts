import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Web mode, server half: the desktop main-process handlers behind node:http.
// An SSR build leaves node_modules (weaviate-client and its gRPC stack)
// external, loaded at runtime like the Electron main bundle does.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  build: {
    ssr: resolve(__dirname, 'src/web/main.ts'),
    outDir: resolve(__dirname, 'out/web/server'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'main.js' } }
  }
})
