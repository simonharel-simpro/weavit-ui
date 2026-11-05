import { describe, expect, it } from 'vitest'
import { createFetchInvoke } from './webInvoke'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: string, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(body, { status })
  }) as unknown as typeof fetch
}

describe('createFetchInvoke', () => {
  it('posts the channel and encoded args with the CSRF header and returns the result', async () => {
    const calls: Call[] = []
    const invoke = createFetchInvoke(fakeFetch(200, JSON.stringify({ result: [1, 2] }), calls))

    await expect(invoke('schema:listCollections', 'conn', undefined)).resolves.toEqual([1, 2])

    const [{ url, init }] = calls
    expect(url).toBe('/api/invoke')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-weavit-web': '1' })
    expect(JSON.parse(String(init.body))).toEqual({ channel: 'schema:listCollections', args: ['conn'] })
  })

  it('resolves undefined for a handler that returned nothing', async () => {
    const invoke = createFetchInvoke(fakeFetch(200, '{}'))
    await expect(invoke('history:clear')).resolves.toBeUndefined()
  })

  it('rejects with the server error message', async () => {
    const invoke = createFetchInvoke(fakeFetch(500, JSON.stringify({ error: 'collection not found' })))
    await expect(invoke('schema:getCollection', 'c', 'X')).rejects.toThrow('collection not found')
  })

  it('rejects clearly on a non-JSON response', async () => {
    const invoke = createFetchInvoke(fakeFetch(502, '<html>bad gateway</html>'))
    await expect(invoke('admin:health', 'c')).rejects.toThrow('non-JSON response (HTTP 502)')
  })
})
