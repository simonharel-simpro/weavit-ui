import type { Invoke } from './api'
import { CSRF_HEADER, encodeArgs, INVOKE_PATH } from './webProtocol'

/** The web-mode transport: one POST per call to the local Weavit web server. */
export function createFetchInvoke(fetchImpl: typeof fetch = fetch): Invoke {
  return async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const res = await fetchImpl(INVOKE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
      body: JSON.stringify({ channel, args: encodeArgs(args) })
    })
    const text = await res.text()
    let payload: { result?: unknown; error?: unknown }
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`Weavit web server returned a non-JSON response (HTTP ${res.status})`)
    }
    if (!res.ok) {
      throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`)
    }
    return payload.result as T
  }
}
