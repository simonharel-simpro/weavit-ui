import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { Handler } from '../main/ipc/registry'
import { createWebServer } from './server'

let server: Server
let port: number
const seen: unknown[][] = []

const handlers = new Map<string, Handler>([
  ['echo', (...args: unknown[]) => { seen.push(args); return { args } }],
  ['boom', () => { throw new Error('weaviate unreachable') }],
  ['nothing', () => undefined]
])

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'weavit-web-'))
  const client = join(root, 'client')
  mkdirSync(join(client, 'assets'), { recursive: true })
  writeFileSync(join(client, 'web.html'), '<html>app</html>')
  writeFileSync(join(client, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'top secret')
  server = createWebServer({ handlers, staticDir: client, indexFile: 'web.html', maxBodyBytes: 1024 })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((done) => server.close(() => done())))

interface Reply { status: number; headers: Record<string, unknown>; body: string }

function call(
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const JSON_HEADERS = { 'content-type': 'application/json', 'x-weavit-web': '1' }
const invoke = (payload: unknown, headers: Record<string, string> = JSON_HEADERS): Promise<Reply> =>
  call('POST', '/api/invoke', { headers, body: JSON.stringify(payload) })

describe('web server — invoke', () => {
  it('runs the handler and returns its result', async () => {
    const r = await invoke({ channel: 'echo', args: ['a', 1] })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ result: { args: ['a', 1] } })
  })

  it('restores undefined arguments before calling the handler', async () => {
    seen.length = 0
    await invoke({ channel: 'echo', args: ['a', { __weavitUndefined: true }, null] })
    expect(seen[0]).toEqual(['a', undefined, null])
    expect(seen[0][1]).toBeUndefined()
  })

  it('answers {} when the handler returns nothing', async () => {
    const r = await invoke({ channel: 'nothing', args: [] })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({})
  })

  it('turns a handler error into a 500 carrying its message', async () => {
    const r = await invoke({ channel: 'boom', args: [] })
    expect(r.status).toBe(500)
    expect(JSON.parse(r.body)).toEqual({ error: 'weaviate unreachable' })
  })

  it('rejects an unknown channel with 404', async () => {
    const r = await invoke({ channel: 'schema:dropEverything', args: [] })
    expect(r.status).toBe(404)
  })

  it.each([
    ['not JSON', '{oops'],
    ['missing args', JSON.stringify({ channel: 'echo' })],
    ['non-string channel', JSON.stringify({ channel: 1, args: [] })]
  ])('rejects a malformed body (%s) with 400', async (_name, body) => {
    const r = await call('POST', '/api/invoke', { headers: JSON_HEADERS, body })
    expect(r.status).toBe(400)
  })

  it('rejects an oversized body with 413', async () => {
    const r = await invoke({ channel: 'echo', args: ['x'.repeat(2048)] })
    expect(r.status).toBe(413)
  })

  it('rejects GET on the invoke route with 405', async () => {
    expect((await call('GET', '/api/invoke')).status).toBe(405)
  })
})

describe('web server — cross-site protections', () => {
  it('refuses an invoke without the custom header (a plain cross-site form post)', async () => {
    const r = await invoke({ channel: 'echo', args: [] }, { 'content-type': 'application/json' })
    expect(r.status).toBe(403)
  })

  it('refuses a non-JSON content type with 415', async () => {
    const r = await invoke({ channel: 'echo', args: [] }, { 'content-type': 'text/plain', 'x-weavit-web': '1' })
    expect(r.status).toBe(415)
  })

  it('refuses a foreign Host header (DNS rebinding) on every route', async () => {
    const rebound = { host: `evil.example:${port}` }
    expect((await call('GET', '/', { headers: rebound })).status).toBe(403)
    expect((await invoke({ channel: 'echo', args: [] }, { ...JSON_HEADERS, ...rebound })).status).toBe(403)
  })

  it('refuses a foreign Origin', async () => {
    const r = await invoke({ channel: 'echo', args: [] }, { ...JSON_HEADERS, origin: 'https://evil.example' })
    expect(r.status).toBe(403)
  })

  it('accepts its own origin and the localhost name', async () => {
    const own = await invoke({ channel: 'echo', args: [] }, { ...JSON_HEADERS, origin: `http://127.0.0.1:${port}` })
    expect(own.status).toBe(200)
    const viaLocalhost = await call('GET', '/', { headers: { host: `localhost:${port}` } })
    expect(viaLocalhost.status).toBe(200)
  })

  it('sends anti-framing and nosniff headers', async () => {
    const r = await call('GET', '/')
    expect(r.headers['x-frame-options']).toBe('DENY')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('web server — static files', () => {
  it('serves the app shell at / and for client-side routes', async () => {
    for (const path of ['/', '/collections/Foo']) {
      const r = await call('GET', path)
      expect(r.status).toBe(200)
      expect(r.body).toBe('<html>app</html>')
      expect(r.headers['content-type']).toContain('text/html')
    }
  })

  it('serves an asset with its content type', async () => {
    const r = await call('GET', '/assets/app.js')
    expect(r.body).toBe('console.log(1)')
    expect(r.headers['content-type']).toContain('text/javascript')
  })

  it.each(['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2F..%2Fsecret.txt'])(
    'never serves a file outside the client dir (%s)',
    async (path) => {
      const r = await call('GET', path)
      expect(r.body).not.toContain('top secret')
    }
  )

  it('rejects a malformed URL with 400', async () => {
    expect((await call('GET', '/%E0%A4%A')).status).toBe(400)
  })
})
