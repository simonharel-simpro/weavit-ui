import { resolve } from 'node:path'
import type { Handler } from '../main/ipc/registry'
import { registerHandlers } from '../main/ipc/registry'
import { setStoreHost } from '../main/store/host'
import { webHost } from './webHost'
import { seedDataLabProfile } from './seed'
import { createWebServer } from './server'
import { setExtraHeaders } from '../main/weaviate/extraHeaders'
import { createDefaultProjectionSession } from '../main/projection/session'

// Same policy as the desktop main process: a dropped Weaviate/gRPC connection
// must not take the whole server down.
process.on('unhandledRejection', (reason) => {
  console.error('[weavit-web] unhandled rejection (ignored):', reason)
})

function port(): number {
  const raw = process.env['WEAVIT_WEB_PORT'] ?? '3080'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`WEAVIT_WEB_PORT must be an integer in 1..65535, got "${raw}"`)
  }
  return n
}

const listenPort = port()
setStoreHost(webHost())
if (process.env['WEAVIT_SEED_DATALAB'] === '1' && seedDataLabProfile()) {
  console.log('[weavit-web] created the data-lab connection profile')
}

// Read once, kept in memory: sent to Weaviate as the OpenAI-module key for the
// OpenRouter preset, never written to a profile nor returned to the browser.
const openRouterKey = process.env['WEAVIT_OPENROUTER_API_KEY']
if (openRouterKey) {
  setExtraHeaders({ 'X-OpenAI-Api-Key': openRouterKey })
  console.log('[weavit-web] OpenRouter key loaded from WEAVIT_OPENROUTER_API_KEY')
}

// The server runs from out/web/server; the repo root (and the sidecar build) is three levels up.
const projection = createDefaultProjectionSession(resolve(__dirname, '../../..'))
const handlers = new Map<string, Handler>()
registerHandlers((channel, fn) => handlers.set(channel, fn), { projection })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    projection.dispose() // F-13: no orphaned sidecar
    process.exit(0)
  })
}

const server = createWebServer({
  handlers,
  staticDir: resolve(__dirname, '../client'),
  indexFile: 'web.html'
})
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `[weavit-web] port ${listenPort} is already in use; set WEAVIT_WEB_PORT`
      : `[weavit-web] ${err.message}`
  )
  process.exit(1)
})
// Loopback only: the server can delete collections and holds connection secrets.
server.listen(listenPort, '127.0.0.1', () => {
  console.log(`[weavit-web] http://127.0.0.1:${listenPort}`)
})
