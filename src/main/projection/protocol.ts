// Protocol v1 between the host and the weavit-projector sidecar: a JSON header
// line plus f32 LE rows on stdin, NDJSON messages on stdout. The fixtures in
// native/projector/fixtures/protocol-v1/ pin both sides (S-14).
import { z } from 'zod'
import { NN_DEFAULT } from '@shared/projection'
import type { ProjectionMethod } from '@shared/types'

export const PROTOCOL = 1
const MAX_LINE_BYTES = 64 * 1024 * 1024

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface Header {
  protocol: 1
  nMax: number
  dim: number
  method: ProjectionMethod
  dims: 2 | 3
  pcaDims: number
  nNeighbors: number
  minDist: number
  epochs: number
  seed: number
  frameEvery: number
  batchRows: number
  fitRows: number
}

export const HEADER_DEFAULTS = {
  protocol: 1,
  pcaDims: 50,
  nNeighbors: NN_DEFAULT,
  minDist: 0.1,
  epochs: 200,
  seed: 42,
  frameEvery: 10,
  batchRows: 1000,
  fitRows: 10_000
} as const satisfies Partial<Header>

/** Keys in protocol order, so the header line is deterministic. */
export function encodeHeader(h: Header): string {
  const { protocol, nMax, dim, method, dims, pcaDims, nNeighbors, minDist } = h
  const { epochs, seed, frameEvery, batchRows, fitRows } = h
  const line = { protocol, nMax, dim, method, dims, pcaDims, nNeighbors, minDist, epochs, seed }
  return JSON.stringify({ ...line, frameEvery, batchRows, fitRows }) + '\n'
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const b64 = z.string().regex(B64, 'not base64')
const count = z.number().int().min(0)
const positive = z.number().int().min(1)

export const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int() }),
  z.object({
    type: z.literal('progress'),
    stage: z.enum(['pca', 'knn', 'graph', 'epochs']),
    done: count,
    total: count
  }),
  z.object({ type: z.literal('basis'), mean: b64, components: b64, pcaDims: positive }),
  z.object({ type: z.literal('pcaChunk'), offset: count, count, coords: b64 }),
  z.object({ type: z.literal('pca50'), n: count, pcaDims: positive, coords: b64 }),
  z.object({ type: z.literal('notice'), message: z.string() }),
  z.object({
    type: z.literal('frame'),
    stage: z.literal('umap'),
    epoch: count,
    epochs: count,
    dims: z.union([z.literal(2), z.literal(3)]),
    n: count,
    coords: b64
  }),
  z.object({ type: z.literal('done'), n: count }),
  z.object({ type: z.literal('error'), message: z.string() })
])
export type SidecarMessage = z.infer<typeof messageSchema>

/** Float count of a base64 f32 payload, without decoding it. */
function floats(s: string): number {
  const bytes = Buffer.byteLength(s, 'base64')
  if (bytes % 4 !== 0) throw new ProtocolError(`f32 payload of ${bytes} bytes`)
  return bytes / 4
}

function expectLength(what: string, actual: number, want: number): void {
  if (actual !== want) throw new ProtocolError(`${what} holds ${actual} floats, expected ${want}`)
}

function checkLengths(m: SidecarMessage): void {
  if (m.type === 'pcaChunk') expectLength('pcaChunk', floats(m.coords), m.count * 3)
  else if (m.type === 'pca50') expectLength('pca50', floats(m.coords), m.n * m.pcaDims)
  else if (m.type === 'frame') expectLength('frame', floats(m.coords), m.n * m.dims)
  else if (m.type === 'basis') {
    expectLength('basis components', floats(m.components), m.pcaDims * floats(m.mean))
  }
}

export function parseMessage(line: string): SidecarMessage {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    throw new ProtocolError(`stdout line of ${line.length} chars is not JSON`)
  }
  const parsed = messageSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ProtocolError(`bad message: ${issue.path.join('.') || 'type'} ${issue.message}`)
  }
  checkLengths(parsed.data)
  return parsed.data
}

/**
 * Splits stdout bytes into lines. It splits on the newline byte before decoding,
 * so a multi-byte character cut across chunks survives.
 */
export class LineSplitter {
  private pending: Buffer[] = []
  private pendingBytes = 0

  push(chunk: Buffer): string[] {
    const out: string[] = []
    let start = 0
    for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
      this.hold(chunk.subarray(start, nl))
      const line = Buffer.concat(this.pending, this.pendingBytes).toString('utf8')
      this.pending = []
      this.pendingBytes = 0
      if (line.trim().length > 0) out.push(line)
      start = nl + 1
    }
    this.hold(chunk.subarray(start))
    return out
  }

  private hold(part: Buffer): void {
    if (part.length === 0) return
    this.pendingBytes += part.length
    if (this.pendingBytes > MAX_LINE_BYTES) {
      throw new ProtocolError(`stdout line over ${MAX_LINE_BYTES / (1024 * 1024)} MB`)
    }
    this.pending.push(part)
  }
}
