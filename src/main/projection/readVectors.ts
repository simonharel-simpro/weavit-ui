// The lean Weaviate vector read for the projector: pages objects, fixes the dimension,
// normalises cosine rows (D-19), streams them page by page. Never logs vectors or values.
import { FILTERED_MAX, LABEL_MAX_CHARS, PAGE_SIZE } from '@shared/projection'
import type { CapReason, PropValue, VectorMetric } from '@shared/types'
import { effectiveCap } from './validate'

export interface RawObject {
  uuid: string
  properties: Record<string, unknown>
  vectors?: Record<string, unknown>
}
export interface VectorSource {
  fetchPage(o: { after?: string; offset?: number; limit: number }): Promise<RawObject[]>
}
export interface ReadArgs {
  source: VectorSource
  vector: string
  props: string[]
  filtered: boolean
  limit: number
  matched?: number
  knownDim?: number
  metric: VectorMetric
  pageTimeoutMs?: number
  onStart(info: { dim: number; cap: number; reason?: CapReason }): Promise<void>
  onPage(rows: Float32Array, count: number): Promise<void>
  isCancelled(): boolean
}
type Skipped = { missing: number; dim: number; nonFinite: number; zeroNorm: number }
export interface ReadResult {
  n: number
  dim: number
  uuids: string[]
  /** One column per prop, row order. */
  props: PropValue[][]
  vectors: Float32Array
  skipped: Skipped
  capReason?: CapReason
}

const pickVector = (o: RawObject, name: string): unknown => o.vectors?.[name] ?? o.vectors?.default

/** Rows that cannot be streamed; `D` is undefined until the dimension is fixed. */
function rejectReason(v: unknown, D: number | undefined): keyof Skipped | undefined {
  if (!Array.isArray(v) || v.length === 0) return 'missing'
  if (v.some(Array.isArray) || v.length !== D) return 'dim' // number[][] is a multi-vector
  // Weaviate stores f32: a value that overflows f32 would reach the sidecar as Infinity.
  if (!v.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x)))) return 'nonFinite'
  return undefined
}

/** U-28: the most common flat vector length on the page; ties → the one seen first. */
function modalLength(page: RawObject[], name: string): number | undefined {
  const counts = new Map<number, number>()
  for (const o of page) {
    const v = pickVector(o, name)
    if (Array.isArray(v) && v.length > 0 && !v.some(Array.isArray)) {
      counts.set(v.length, (counts.get(v.length) ?? 0) + 1)
    }
  }
  let best: number | undefined
  for (const [len, c] of counts) if (best === undefined || c > (counts.get(best) ?? 0)) best = len
  return best
}

function label(v: unknown): PropValue {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v !== 'string') return null
  if (v.length <= LABEL_MAX_CHARS) return v
  const cut = v.slice(0, LABEL_MAX_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut // never split a surrogate pair
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`page read timed out after ${ms / 1000} s`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

class Reader {
  n = 0
  cap = 0
  D: number | undefined
  reason: CapReason | undefined
  buf = new Float32Array(0)
  started = false
  truncated = false
  readonly uuids: string[] = []
  readonly cols: PropValue[][]
  readonly skipped: Skipped = { missing: 0, dim: 0, nonFinite: 0, zeroNorm: 0 }
  private readonly seen: Set<string> | undefined

  constructor(private readonly a: ReadArgs) {
    this.cols = a.props.map(() => [])
    this.seen = a.filtered ? new Set() : undefined
  }

  /** F-3: offset pages can shift under concurrent writes; keep each uuid once. */
  fresh(page: RawObject[]): RawObject[] {
    const seen = this.seen
    if (!seen) return page
    return page.filter((o) => !seen.has(o.uuid) && seen.add(o.uuid) !== undefined)
  }

  fixDim(page: RawObject[]): boolean {
    const mode = modalLength(page, this.a.vector)
    if (mode === undefined) return false
    this.D = this.a.knownDim ?? mode
    const { limit, matched, filtered } = this.a
    ;({ cap: this.cap, reason: this.reason } = effectiveCap({ limit, d: this.D, matched, filtered }))
    this.buf = new Float32Array(this.cap * this.D)
    return true
  }

  /** Returns how many objects of the page were consumed before the cap. */
  ingest(page: RawObject[]): number {
    let i = 0
    while (i < page.length && this.n < this.cap) this.add(page[i++])
    return i
  }

  private add(o: RawObject): void {
    const v = pickVector(o, this.a.vector)
    const why = rejectReason(v, this.D)
    if (why) return void this.skipped[why]++
    const row = v as number[]
    let scale = 1
    if (this.a.metric === 'cosine') {
      let sq = 0
      for (const x of row) sq += x * x
      if (sq === 0) return void this.skipped.zeroNorm++
      scale = 1 / Math.sqrt(sq)
    }
    const at = this.n * row.length
    for (let j = 0; j < row.length; j++) this.buf[at + j] = row[j] * scale
    this.uuids.push(o.uuid)
    this.a.props.forEach((p, k) => this.cols[k].push(label(o.properties?.[p])))
    this.n++
  }

  async flush(from: number): Promise<void> {
    if (this.n === from || this.D === undefined) return
    if (!this.started) {
      this.started = true
      await this.a.onStart({ dim: this.D, cap: this.cap, reason: this.reason })
    }
    await this.a.onPage(this.buf.subarray(from * this.D, this.n * this.D), this.n - from)
  }
}

export async function readVectors(a: ReadArgs): Promise<ReadResult> {
  const r = new Reader(a)
  const ms = a.pageTimeoutMs ?? 30_000
  let offset = 0
  let after: string | undefined
  while (!a.isCancelled()) {
    // A filtered read pages by offset, which the server refuses past FILTERED_MAX.
    const limit = a.filtered ? Math.min(PAGE_SIZE, FILTERED_MAX - offset) : PAGE_SIZE
    if (limit <= 0) break
    const page = await withTimeout(a.source.fetchPage(a.filtered ? { offset, limit } : { after, limit }), ms)
    if (page.length === 0) break
    offset += page.length
    after = page[page.length - 1].uuid
    const objs = r.fresh(page)
    if (r.D === undefined && !r.fixDim(objs)) {
      for (const o of objs) r.skipped[rejectReason(pickVector(o, a.vector), undefined) ?? 'missing']++
    } else {
      const from = r.n
      const used = r.ingest(objs)
      await r.flush(from)
      if (r.n >= r.cap) {
        r.truncated = used < objs.length || page.length === limit
        break
      }
    }
    if (page.length < limit) break
  }
  if (r.uuids.length !== r.n) throw new Error(`read bookkeeping: ${r.uuids.length} uuids for ${r.n} rows`)
  return {
    n: r.n,
    dim: r.D ?? 0,
    uuids: r.uuids,
    props: r.cols,
    vectors: r.buf.subarray(0, r.n * (r.D ?? 0)),
    skipped: r.skipped,
    capReason: finalReason(r, a.matched)
  }
}

/** U-40: a cap is reported only when the read actually stopped at it. */
function finalReason(r: Reader, matched: number | undefined): CapReason | undefined {
  if (r.n === 0 || r.n !== r.cap) return undefined
  if (r.reason) return r.reason
  return r.truncated && (matched === undefined || matched > r.n) ? 'limit' : undefined
}
