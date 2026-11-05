// Wire format between the web renderer and the web server (web mode only).
// IPC uses structured clone, which keeps `undefined` arguments; JSON turns them
// into `null`, and some handlers read the two differently (connections:upsert:
// `undefined` keeps the stored API key, `null` clears it). So top-level
// `undefined` arguments travel as a sentinel and are restored on the server.

export const INVOKE_PATH = '/api/invoke'
/** Custom header every invoke must carry: a cross-site page cannot send it
 *  without a CORS preflight, which the server never grants. */
export const CSRF_HEADER = 'x-weavit-web'

const UNDEFINED_KEY = '__weavitUndefined'

export interface InvokeBody {
  channel: string
  args: unknown[]
}

function isSentinel(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>)[UNDEFINED_KEY] === true
  )
}

export function encodeArgs(args: readonly unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return args.slice(0, end).map((a) => (a === undefined ? { [UNDEFINED_KEY]: true } : a))
}

export function decodeArgs(args: readonly unknown[]): unknown[] {
  return args.map((a) => (isSentinel(a) ? undefined : a))
}
