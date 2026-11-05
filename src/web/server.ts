import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Handler } from '../main/ipc/registry'
import { CSRF_HEADER, decodeArgs, INVOKE_PATH, type InvokeBody } from '@shared/webProtocol'

export interface WebServerOptions {
  handlers: ReadonlyMap<string, Handler>
  /** Built renderer (out/web/client). */
  staticDir: string
  /** HTML entry served for `/` and for any unknown path (single-page app). */
  indexFile?: string
  maxBodyBytes?: number
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

/** Only loopback names on our own port: a DNS-rebinding page arrives with its own host name. */
function checkHost(req: IncomingMessage): void {
  const port = req.socket.localPort
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`]
  const host = req.headers.host ?? ''
  if (!allowed.includes(host)) throw new HttpError(403, `Host "${host}" is not allowed`)
  const origin = req.headers.origin
  if (origin !== undefined && !allowed.some((h) => origin === `http://${h}`)) {
    throw new HttpError(403, `Origin "${origin}" is not allowed`)
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, `Request body exceeds ${limit} bytes`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function parseInvoke(raw: string): InvokeBody {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON')
  }
  const b = body as Partial<InvokeBody> | null
  if (!b || typeof b.channel !== 'string' || !Array.isArray(b.args)) {
    throw new HttpError(400, 'Expected {"channel": string, "args": array}')
  }
  return { channel: b.channel, args: b.args }
}

async function invoke(req: IncomingMessage, res: ServerResponse, opts: WebServerOptions): Promise<void> {
  if (req.method !== 'POST') throw new HttpError(405, 'Use POST')
  if (req.headers[CSRF_HEADER] !== '1') throw new HttpError(403, `Missing ${CSRF_HEADER} header`)
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json')
  }
  const { channel, args } = parseInvoke(await readBody(req, opts.maxBodyBytes ?? 64 * 1024 * 1024))
  const handler = opts.handlers.get(channel)
  if (!handler) throw new HttpError(404, `Unknown channel "${channel}"`)
  let result: unknown
  try {
    result = await handler(...decodeArgs(args))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // The renderer shows the message too; the log keeps the "why" when nobody is looking.
    console.error(`[weavit-web] ${channel} failed: ${message}`)
    sendJson(res, 500, { error: message })
    return
  }
  sendJson(res, 200, { result })
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, opts: WebServerOptions): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Use GET')
  const root = resolve(opts.staticDir)
  const index = resolve(root, opts.indexFile ?? 'index.html')
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    throw new HttpError(400, 'Malformed URL')
  }
  let file = resolve(root, `.${pathname}`)
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, 'Not found')
  const found = await stat(file).catch(() => null)
  if (!found?.isFile()) file = index // client-side routes and `/` both land on the app shell
  const body = await readFile(file).catch(() => {
    throw new HttpError(404, 'Not found')
  })
  send(res, 200, req.method === 'HEAD' ? '' : body, CONTENT_TYPES[extname(file)] ?? 'application/octet-stream')
}

export function createWebServer(opts: WebServerOptions): Server {
  return createServer((req, res) => {
    const route = async (): Promise<void> => {
      checkHost(req)
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path === INVOKE_PATH) await invoke(req, res, opts)
      else await serveStatic(req, res, opts)
    }
    route().catch((e: unknown) => {
      if (res.headersSent) return res.destroy()
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.message })
      else sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
    })
  })
}
