import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectionConfig } from '@shared/types'
import { readVectors, type RawObject, type ReadArgs } from './readVectors'
import { effectiveCap, metricOf, validateStart } from './validate'

let uid = 0
const obj = (vec: unknown, properties: Record<string, unknown> = {}, uuid?: string): RawObject => ({
  uuid: uuid ?? `u${uid++}`,
  properties,
  vectors: vec === undefined ? {} : { v: vec }
})
const rows = (count: number, d: number): RawObject[] =>
  Array.from({ length: count }, (_, i) => obj(Array.from({ length: d }, (_, j) => i + j + 1)))
const chunk = <T>(xs: T[], size = 1000): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size))

/** Serves the pages in call order, then empty pages. */
function fakeSource(pages: (RawObject[] | Error | 'hang')[]) {
  const calls: { after?: string; offset?: number; limit: number }[] = []
  return {
    calls,
    fetchPage(o: { after?: string; offset?: number; limit: number }): Promise<RawObject[]> {
      calls.push(o)
      const p = pages[calls.length - 1] ?? []
      if (p === 'hang') return new Promise(() => {})
      return p instanceof Error ? Promise.reject(p) : Promise.resolve(p)
    }
  }
}

function run(pages: (RawObject[] | Error | 'hang')[], over: Partial<ReadArgs> = {}) {
  const source = fakeSource(pages)
  const written: number[][] = []
  const starts: { dim: number; cap: number; fetchedBefore: number }[] = []
  let dim = 0
  const args: ReadArgs = {
    source,
    vector: 'v',
    props: [],
    filtered: false,
    limit: 100_000,
    metric: 'dot',
    onStart: async (info) => {
      dim = info.dim
      starts.push({ dim: info.dim, cap: info.cap, fetchedBefore: source.calls.length })
    },
    onPage: async (r, count) => {
      for (let i = 0; i < count; i++) written.push(Array.from(r.subarray(i * dim, (i + 1) * dim)))
    },
    isCancelled: () => false,
    ...over
  }
  return { source, written, starts, result: readVectors(args) }
}

const norm = (r: number[]) => Math.hypot(...r)

afterEach(() => {
  vi.useRealTimers()
})

describe('readVectors — rows', () => {
  it('F-2: should skip objects with a missing, wrong-length or non-finite vector and count them', async () => {
    const page = [obj([1, 2, 3]), obj(undefined), obj([1, 2]), obj([1, NaN, 3]), obj([4, 5, 6])]
    const { result } = run([page], { metric: 'cosine' })
    const r = await result
    expect(r.n).toBe(2)
    expect(r.uuids).toEqual([page[0].uuid, page[4].uuid])
    expect(r.skipped).toEqual({ missing: 1, dim: 1, nonFinite: 1, zeroNorm: 0 })
  })

  it("F-2: should read an unnamed collection's vector from the default key", async () => {
    const config: CollectionConfig = {
      name: 'Old',
      properties: [],
      references: [],
      namedVectors: [{ name: 'default' }],
      multiTenancy: { enabled: false },
      raw: {}
    }
    const req = { source: { kind: 'read', connectionId: 'c', collection: 'Old', vector: 'default', limit: 10 }, method: 'pca', dims: 2 }
    const v = validateStart(req, { config })
    expect(v.kind === 'read' && v.includeVector).toBe(true)
    const o: RawObject = { uuid: 'a', properties: {}, vectors: { default: [3, 4] } }
    const { result, written } = run([[o]], { vector: 'default' })
    expect((await result).n).toBe(1)
    expect(written).toEqual([[3, 4]])
    const named = run([[o]], { vector: 'v' })
    expect((await named.result).n).toBe(1)
    expect(named.written).toEqual([[3, 4]])
  })

  it('U-7: should skip objects without the named vector and count them', async () => {
    const all = rows(2500, 4)
    all[1200] = obj(undefined)
    all[1700] = obj(undefined)
    const r = await run(chunk(all)).result
    expect(r.n).toBe(2500 - 2)
    expect(r.skipped.missing).toBe(2)
  })

  it('U-28: should fix D from the modal length on page 1', async () => {
    const r = await run([[...rows(1, 128), ...rows(999, 384)]]).result
    expect(r.dim).toBe(384)
    expect(r.n).toBe(999)
    expect(r.skipped.dim).toBe(1)
  })

  it('takes D from knownDim when given', async () => {
    const r = await run([[...rows(3, 2), ...rows(1, 4)]], { knownDim: 4 }).result
    expect(r.dim).toBe(4)
    expect(r.n).toBe(1)
  })

  it('F-17: should truncate label values to 200 characters', async () => {
    const page = [obj([1, 2], { title: 'x'.repeat(5000), year: 1999, ok: true })]
    const r = await run([page], { props: ['title', 'year', 'ok', 'gone'] }).result
    expect((r.props[0][0] as string).length).toBe(200)
    expect(r.props[1][0]).toBe(1999)
    expect(r.props[2][0]).toBe(true)
    expect(r.props[3][0]).toBeNull()
  })
})

describe('readVectors — metric (D-19)', () => {
  const input = () => [obj([1, 0]), obj([100, 1]), obj([0, 1])]

  it('U-20: should L2-normalise rows for a cosine metric', async () => {
    const { result, written } = run([input()], { metric: 'cosine' })
    await result
    for (const r of written) expect(norm(r)).toBeCloseTo(1, 6)
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1])
    const nearest = [1, 2].sort((x, y) => dist(written[0], written[x]) - dist(written[0], written[y]))[0]
    expect(nearest).toBe(1)
  })

  it.each(['l2-squared', 'dot'])('U-20: should stream raw rows for %s', async (metric) => {
    const { result, written } = run([input()], { metric })
    await result
    expect(written).toEqual([[1, 0], [100, 1], [0, 1]])
  })

  it('U-20: should skip a zero vector under cosine', async () => {
    const r = await run([[obj([0, 0]), obj([1, 0])]], { metric: 'cosine' }).result
    expect(r.n).toBe(1)
    expect(r.skipped.zeroNorm).toBe(1)
  })

  it('U-37: should stream raw rows for manhattan and unknown metrics', async () => {
    const base = { name: 'v' }
    expect(metricOf({ ...base })).toBe('cosine')
    for (const distance of ['manhattan', 'foo']) {
      const metric = metricOf({ ...base, distance })
      expect(metric).toBe(distance)
      const { result, written } = run([[obj([100, 1])]], { metric })
      await result
      expect(written).toEqual([[100, 1]])
    }
  })
})

describe('readVectors — order and caps', () => {
  it('U-41: should fix D on the first page that has vectors', async () => {
    const { result, starts } = run([chunk(rows(1000, 1).map(() => obj(undefined)))[0], rows(1000, 384)])
    const r = await result
    expect(r).toMatchObject({ dim: 384, n: 1000 })
    expect(r.skipped.missing).toBe(1000)
    expect(starts).toHaveLength(1)
    expect(starts[0].fetchedBefore).toBe(2)
    const empty = run([0, 1, 2].map(() => rows(1000, 1).map(() => obj(undefined))))
    expect((await empty.result).n).toBe(0)
    expect(empty.starts).toHaveLength(0)
  })

  it('U-40: should give no reason when the count equals the cap', async () => {
    const pages = chunk(rows(100_000, 2))
    const exact = await run(pages, { matched: 100_000 }).result
    expect(exact.n).toBe(100_000)
    expect(exact.capReason).toBeUndefined()
    const more = await run(pages, { matched: 250_000 }).result
    expect(more.capReason).toBe('limit')
  })

  it('U-40: should drop the cap reason when the read ends below the cap', async () => {
    const filtered = await run([rows(500, 2)], { filtered: true }).result
    expect(filtered.n).toBe(500)
    expect(filtered.capReason).toBeUndefined()
    const limited = await run(chunk(rows(5000, 2)), { limit: 1000 }).result
    expect(limited.n).toBe(1000)
    expect(limited.capReason).toBe('limit')
  })

  it('U-1: should cap a filtered read at the offset limit and report matched vs read', async () => {
    const { result, source } = run(chunk(rows(25_000, 2)), { filtered: true, matched: 25_000 })
    const r = await result
    expect(r.n).toBe(10_000)
    expect(r.capReason).toBe('offsetLimit')
    expect(source.calls.every((c) => c.offset !== undefined && c.offset + c.limit <= 10_000)).toBe(true)
    expect(effectiveCap({ limit: 100_000, d: 384, matched: 25_000, filtered: true })).toEqual({
      cap: 10_000,
      reason: 'offsetLimit'
    })
  })

  it('never pages a filtered read past the server offset limit', async () => {
    const all = rows(25_000, 2)
    for (let i = 0; i < 5; i++) all[i] = obj(undefined)
    const { result, source } = run(chunk(all), { filtered: true, matched: 25_000 })
    const r = await result
    expect(r.n).toBe(9995)
    expect(source.calls.map((c) => c.offset)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => k * 1000))
  })

  it('advances the cursor with the last uuid of each unfiltered page', async () => {
    const pages = chunk(rows(2000, 2))
    const { result, source } = run(pages)
    await result
    expect(source.calls[1]).toEqual({ after: pages[0][999].uuid, limit: 1000 })
  })
})

describe('readVectors — failures', () => {
  it('F-7: should fail when a page read exceeds the timeout', async () => {
    vi.useFakeTimers()
    const { result } = run(['hang'], { pageTimeoutMs: 30_000 })
    const settled = expect(result).rejects.toThrow('page read timed out after 30 s')
    await vi.advanceTimersByTimeAsync(30_001)
    await settled
  })

  it('U-51: should return the partial result of a cancelled read', async () => {
    const pages = chunk(rows(5000, 2))
    const holder: { source?: ReturnType<typeof fakeSource> } = {}
    const cancelled = run(pages, { isCancelled: () => (holder.source?.calls.length ?? 0) >= 2 })
    holder.source = cancelled.source
    const r = await cancelled.result
    expect(r.n).toBe(2000)
    expect(r.uuids).toHaveLength(2000)
    expect(cancelled.source.calls).toHaveLength(2)
    const failing = run([pages[0], pages[1], new Error('boom')])
    await expect(failing.result).rejects.toThrow('boom')
  })

  it('F-3: should drop a uuid repeated across offset pages', async () => {
    const page1 = rows(1000, 2)
    const page2 = [obj([9, 9], {}, page1[10].uuid), ...rows(5, 2)]
    const r = await run([page1, page2], { filtered: true }).result
    expect(r.uuids.filter((u) => u === page1[10].uuid)).toHaveLength(1)
    expect(r.n).toBe(1005)
  })

  it('F-3: should reject with the Weaviate message when a filtered page throws', async () => {
    const pages = chunk(rows(3000, 2))
    const { result } = run([...pages, new Error('query maximum results exceeded')], { filtered: true })
    await expect(result).rejects.toThrow('query maximum results exceeded')
  })

  it('rejects when onPage rejects', async () => {
    const { result } = run([rows(10, 2)], { onPage: () => Promise.reject(new Error('pipe closed')) })
    await expect(result).rejects.toThrow('pipe closed')
  })
})
