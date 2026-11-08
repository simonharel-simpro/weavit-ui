import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectionConfig, FilterNode, ProjectionStartRequest, ProjectionStatusKnown } from '@shared/types'
import { encodeF32 } from './protocol'
import type { RawObject } from './readVectors'
import { createProjectionSession, type ProjectionSession, type SessionDeps } from './session'
import type { SpawnFn } from './sidecar'
import { createSlot, type Slot } from './state'
import { scopeSchema } from './validate'

class FakeChild extends EventEmitter {
  header: Record<string, unknown> | undefined
  /** Hold every row write after the header (its callback) until the child exits. */
  stalled = false
  held: (() => void)[] = []
  stdin = new Writable({
    highWaterMark: 1,
    write: (chunk: Buffer, _enc, cb: () => void) => {
      if (this.header === undefined) this.header = JSON.parse(chunk.toString('utf8'))
      else if (this.stalled) return void this.held.push(cb)
      cb()
    }
  })
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = 4242
  exitOnKill = true
  private hello = false
  kill = vi.fn((signal?: NodeJS.Signals) => {
    if (this.exitOnKill) queueMicrotask(() => this.exit(null, signal ?? 'SIGTERM'))
    return true
  })
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
  out(m: Record<string, unknown>): void {
    const hello = this.hello ? '' : '{"type":"hello","protocol":1}\n'
    this.hello = true
    this.stdout.emit('data', Buffer.from(hello + JSON.stringify(m) + '\n'))
  }
}

type Deferred = { promise: Promise<RawObject[]>; resolve(v: RawObject[]): void; reject(e: Error): void }
const deferred = (): Deferred => {
  let resolve!: (v: RawObject[]) => void
  let reject!: (e: Error) => void
  const promise = new Promise<RawObject[]>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
type Page = RawObject[] | Error | Deferred

const vec = (i: number, d: number): number[] => Array.from({ length: d }, (_, j) => ((i * 7 + j * 3) % 11) + 1)
const rows = (count: number, d = 4, start = 0): RawObject[] =>
  Array.from({ length: count }, (_, k) => ({
    uuid: `u${start + k}`,
    properties: { title: `t${start + k}`, year: start + k },
    vectors: { vec: vec(start + k, d) }
  }))
/** `count` rows as full pages (an empty page ends the read). */
const pagesOf = (count: number, d = 4): Page[] =>
  Array.from({ length: Math.ceil(count / 1000) }, (_, i) => rows(Math.min(1000, count - i * 1000), d, i * 1000))

const F: FilterNode[] = [{ property: 'year', operator: 'GreaterThan', value: '1', valueType: 'int' }]
const builtF = { prop: 'year', op: 'greaterThan', value: 1 }
const config = (distance = 'cosine'): CollectionConfig => ({
  name: 'A',
  properties: [
    { name: 'title', dataType: ['text'] },
    { name: 'year', dataType: ['int'] },
    { name: 'tags', dataType: ['text[]'] }
  ],
  references: [],
  namedVectors: [{ name: 'vec', distance }],
  multiTenancy: { enabled: true },
  raw: {}
})
const readReq = (over: Partial<ProjectionStartRequest['source']> = {}, dims: 2 | 3 = 2): ProjectionStartRequest => ({
  source: { kind: 'read', connectionId: 'c', collection: 'A', vector: 'vec', limit: 100_000, ...over } as ProjectionStartRequest['source'],
  method: 'umap',
  dims
})
const selReq = (jobId: string, indices: number[], dims: 2 | 3 = 2): ProjectionStartRequest => ({
  source: { kind: 'selection', jobId, indices },
  method: 'umap',
  dims
})
const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i)
const enc = (a: number[]): string => encodeF32(Float32Array.from(a))
const identity = (p: number, d: number): number[] =>
  Array.from({ length: p * d }, (_, k) => (Math.floor(k / d) === k % d ? 1 : 0))

let session: ProjectionSession | undefined
afterEach(() => session?.dispose())

function setup(o: { pages?: Page[]; stall?: boolean; distance?: string; overAll?: () => Promise<{ totalCount?: number }>; stat?: SessionDeps['stat'] } = {}) {
  const children: FakeChild[] = []
  const script = [...(o.pages ?? [])]
  const fetchObjects = vi.fn((_o: Record<string, unknown>) => {
    const p = script.shift() ?? []
    if (p instanceof Error) return Promise.reject(p)
    return (Array.isArray(p) ? Promise.resolve(p) : p.promise).then((objects) => ({ objects }))
  })
  const fetchesAtSpawn: number[] = []
  const spawnFn = vi.fn(() => {
    fetchesAtSpawn.push(fetchObjects.mock.calls.length)
    const c = new FakeChild()
    c.stalled = o.stall ?? false
    children.push(c)
    return c
  }) as unknown as SpawnFn
  const overAll = vi.fn((_o?: Record<string, unknown>) => (o.overAll ?? (async () => ({ totalCount: undefined })))())
  const filter = { byProperty: (prop: string) => ({ greaterThan: (value: unknown) => ({ prop, op: 'greaterThan', value }) }) }
  const handle = { query: { fetchObjects }, aggregate: { overAll }, filter }
  let id = 0
  const deps: SessionDeps = {
    appRoot: '/app',
    env: {},
    platform: 'linux',
    stat: o.stat ?? (() => ({ isFile: true, executable: true })),
    getCollection: vi.fn(async () => handle),
    getConfig: vi.fn(async () => config(o.distance)),
    spawnFn,
    newId: () => `id${++id}`
  }
  const slot: Slot = createSlot()
  session = createProjectionSession(deps, slot)
  const s = session
  const st = (jobId: string, opts = {}) => s.status(jobId, opts) as ProjectionStatusKnown
  return { s, slot, deps, children, spawnFn, fetchObjects, fetchesAtSpawn, overAll, st, script }
}

/** Basis (mean `mean`, identity components), the PCA rows, pca50 = rows − mean. */
function emitPca(child: FakeChild, n: number, d: number, mean: number, src: (i: number) => number[] = (i) => vec(i, d)) {
  child.out({ type: 'basis', mean: enc(new Array(d).fill(mean)), components: enc(identity(d, d)), pcaDims: d })
  child.out({ type: 'pcaChunk', offset: 0, count: n, coords: enc(range(n).flatMap((i) => src(i).slice(0, 3).map((x) => x - mean))) })
  child.out({ type: 'pca50', n, pcaDims: d, coords: enc(range(n).flatMap((i) => src(i).map((x) => x - mean))) })
}
const emitFrame = (child: FakeChild, n: number, epoch: number) =>
  child.out({ type: 'frame', stage: 'umap', epoch, epochs: 200, dims: 2, n, coords: enc(range(n).flatMap((i) => [i, -i])) })
const finish = (child: FakeChild, n: number) => {
  child.out({ type: 'done', n })
  child.exit(0)
}
const until = (f: () => void) => vi.waitFor(f, { timeout: 2000 })

/** A complete root read of `n` rows that reached pca50 with basis mean `mean`, finished. */
async function rootRun(t: ReturnType<typeof setup>, n: number, mean = 0) {
  t.script.push(...pagesOf(n))
  const ids = await t.s.start(readReq({ filters: F }))
  await until(() => expect(t.slot.run?.state).toBe('computing'))
  const child = t.children.at(-1)!
  emitPca(child, n, 4, mean)
  emitFrame(child, n, 10)
  finish(child, n)
  await until(() => expect(t.st(ids.jobId).state).toBe('done'))
  return ids
}
async function selection(t: ReturnType<typeof setup>, jobId: string, indices: number[], mean: number, dims: 2 | 3 = 2) {
  const ids = await t.s.start(selReq(jobId, indices, dims))
  await until(() => expect(t.slot.run?.state).toBe('computing'))
  emitPca(t.children.at(-1)!, indices.length, 4, mean, (i) => vec(indices[i], 4))
  return ids
}

describe('session — start and read', () => {
  it('session: start resolves before the read completes', async () => {
    const t = setup({ pages: [deferred()] })
    const ids = await t.s.start(readReq())
    expect(ids).toEqual({ jobId: expect.any(String), runId: expect.any(String) })
    expect(t.st(ids.jobId).state).toBe('reading')
  })

  it('session: spawns after page 1 with nMax = cap and dim = D', async () => {
    const t = setup({ pages: [rows(1000, 384), deferred()] })
    await t.s.start(readReq({ limit: 5000 }))
    await until(() => expect(t.children[0]?.header).toBeDefined())
    expect(t.fetchesAtSpawn).toEqual([1])
    expect(t.children[0].header).toMatchObject({ nMax: 5000, dim: 384, method: 'umap', dims: 2 })
  })

  it('F-8: should not read when the binary is unresolvable', async () => {
    const t = setup({ stat: () => undefined })
    await expect(t.s.start(readReq())).rejects.toThrow(/does not exist — build it with `pnpm projector:build`/)
    expect(t.fetchObjects).not.toHaveBeenCalled()
  })

  it('F-1: should start a run when the aggregate count throws', async () => {
    const t = setup({ pages: [rows(1000), deferred()], overAll: () => Promise.reject(new Error('aggregate down')) })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(1000))
    expect(t.st(jobId).state).toBe('reading')
    expect(t.st(jobId).progress?.total).toBeUndefined()
  })

  it('F-3: should fail the run, not finish it, when a filtered page throws', async () => {
    const msg = 'query maximum results exceeded'
    const t = setup({ pages: [...pagesOf(3000), new Error(msg)] })
    const { jobId } = await t.s.start(readReq({ filters: F }))
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.st(jobId).error).toContain(msg)
    expect(t.children[0].kill).toHaveBeenCalled()
    finish(t.children[0], 3000)
    expect(t.st(jobId).state).toBe('failed')
  })

  it('F-4: should fail the run and keep the host alive when the child closes stdin mid-stream', async () => {
    const page2 = deferred()
    const t = setup({ pages: [rows(1000), page2] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(1000))
    t.children[0].stdin.destroy(new Error('write EPIPE'))
    page2.resolve(rows(1000, 4, 1000))
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.fetchObjects).toHaveBeenCalledTimes(2)
  })

  it('F-7: should fail the run and kill the child when a page read rejects', async () => {
    const t = setup({ pages: [rows(1000), new Error('connection reset')] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.st(jobId).error).toBe('connection reset')
    expect(t.children[0].kill).toHaveBeenCalled()
  })

  it('F-18: should finish as empty without spawning when the read returns 0 rows / U-9: should not spawn the sidecar for an empty read', async () => {
    const t = setup({ pages: [[]] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).state).toBe('empty'))
    expect(t.st(jobId).n).toBe(0)
    expect(t.spawnFn).not.toHaveBeenCalled()
  })

  it('status: n and readComplete mid-read', async () => {
    const page3 = deferred()
    const t = setup({ pages: [...pagesOf(2000), page3] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(2000))
    expect(t.st(jobId).readComplete).toBe(false)
    page3.resolve([])
    await until(() => expect(t.st(jobId).readComplete).toBe(true))
  })

  it('U-40: should pass the filters to the count', async () => {
    const t = setup({ pages: [rows(500)], overAll: async () => ({ totalCount: 500 }) })
    await t.s.start(readReq({ filters: F }))
    await until(() => expect(t.overAll).toHaveBeenCalledTimes(1))
    expect(t.overAll.mock.calls[0]).toEqual([{ filters: builtF }])
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    expect(t.slot.run?.progress?.total).toBe(500)
    t.script.push(rows(10))
    await t.s.start(readReq())
    await until(() => expect(t.overAll).toHaveBeenCalledTimes(2))
    expect(t.overAll.mock.calls[1][0]).toBeUndefined()
  })
})

describe('session — supersede, cancel, dispose', () => {
  it('F-5: should ignore a frame and an exit from a killed run after a new run starts', async () => {
    const t = setup({ pages: [rows(1000), []] })
    await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    const a = t.slot.run!
    t.children[0].exitOnKill = false
    t.script.push(rows(1000), deferred())
    const b = await t.s.start(readReq())
    await until(() => expect(t.spawnFn).toHaveBeenCalledTimes(2))
    const before = JSON.stringify(t.st(b.jobId))
    emitPca(t.children[0], 1000, 4, 0)
    emitFrame(t.children[0], 1000, 10)
    t.children[0].exit(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(JSON.stringify(t.st(b.jobId))).toBe(before)
    expect(a).toMatchObject({ state: 'superseded', frameVersion: 0 })
    expect(a.umap).toBeUndefined()
    expect(t.slot.contexts.has(a.runId)).toBe(false)
  })

  it('F-5: should reject a selection whose jobId is not the current dataset', async () => {
    const t = setup()
    const a = await rootRun(t, 100)
    t.script.push(deferred())
    await t.s.start(readReq())
    const spawned = vi.mocked(t.spawnFn).mock.calls.length
    await expect(t.s.start(selReq(a.jobId, range(20)))).rejects.toThrow(/no longer current/)
    expect(t.spawnFn).toHaveBeenCalledTimes(spawned)
  })

  it('F-12: should return a terminal unknown state for an unknown jobId', () => {
    const t = setup()
    expect(t.s.status('nope')).toEqual({ jobId: 'nope', state: 'unknown' })
  })

  it('F-13: should kill the running child when the session is disposed', async () => {
    const t = setup({ pages: [rows(100)] })
    await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    t.s.dispose()
    expect(t.children[0].kill).toHaveBeenCalled()
  })

  it('U-15: should keep the last frame after cancel and report the stage', async () => {
    const t = setup({ pages: [rows(100)] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    emitPca(t.children[0], 100, 4, 0)
    emitFrame(t.children[0], 100, 10)
    emitFrame(t.children[0], 100, 20)
    t.s.cancel(jobId)
    const after = t.st(jobId)
    expect(after).toMatchObject({ state: 'cancelled', umap: { epoch: 20 }, stage: 'epochs' })
    t.s.cancel(jobId)
    await new Promise((r) => setTimeout(r, 10))
    expect(t.st(jobId)).toEqual(after)
  })

  it('U-30: should reject a selection after a cancelled read', async () => {
    const page2 = deferred()
    const t = setup({ pages: [rows(1000), page2] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(1000))
    t.s.cancel(jobId)
    page2.resolve(rows(1000, 4, 1000))
    await until(() => expect(t.slot.dataset?.complete).toBe(false))
    await expect(t.s.start(selReq(jobId, range(20)))).rejects.toThrow('read was cancelled — Run again to select')
  })

  it('U-51: should serve points for a cancelled read', async () => {
    const page3 = deferred()
    const t = setup({ pages: [...pagesOf(2000), page3] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(2000))
    t.s.cancel(jobId)
    page3.resolve(rows(1000, 4, 2000))
    await until(() => expect(t.slot.dataset).toBeDefined())
    const s = t.st(jobId, { points: true })
    expect(s).toMatchObject({ state: 'cancelled', readComplete: false })
    expect(s.points?.uuids.length).toBe(2000)
  })

  it('U-51: should keep the partial dataset when a cancel interrupts a pending write', async () => {
    const t = setup({ pages: [rows(1000), rows(1000, 4, 1000)], stall: true })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.children[0]?.held.length).toBe(1))
    t.s.cancel(jobId)
    await until(() => expect(t.slot.dataset).toBeDefined())
    expect(t.st(jobId).state).toBe('cancelled')
    expect(t.st(jobId, { points: true }).points?.uuids.length).toBe(1000)
  })

  it('U-51: should drop the dataset when the read fails', async () => {
    const t = setup({ pages: [...pagesOf(2000), new Error('boom')] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.st(jobId).readComplete).toBe(false)
    expect(t.slot.dataset).toBeUndefined()
    expect(t.st(jobId, { points: true }).points).toBeUndefined()

    // The child dies mid-read, then the read itself ends normally.
    const last = deferred()
    t.script.push(rows(1000), last)
    const mid = await t.s.start(readReq())
    await until(() => expect(t.st(mid.jobId).n).toBe(1000))
    t.children.at(-1)!.exit(1)
    await until(() => expect(t.st(mid.jobId).state).toBe('failed'))
    last.resolve([])
    await new Promise((r) => setTimeout(r, 10))
    expect(t.st(mid.jobId).readComplete).toBe(false)
    expect(t.slot.dataset).toBeUndefined()

    t.script.push(rows(100))
    const b = await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    t.children.at(-1)!.exit(1)
    await until(() => expect(t.st(b.jobId).state).toBe('failed'))
    expect(t.st(b.jobId).readComplete).toBe(true)
    expect(t.st(b.jobId, { points: true }).points?.uuids.length).toBe(100)
  })

  it('U-46: should keep the newer of two racing starts', async () => {
    const t = setup({ pages: [rows(100)] })
    let releaseA!: () => void
    let releaseB!: () => void
    vi.mocked(t.deps.getConfig)
      .mockImplementationOnce(() => new Promise((r) => (releaseA = () => r(config()))))
      .mockImplementationOnce(() => new Promise((r) => (releaseB = () => r(config()))))
    const a = t.s.start(readReq())
    const b = t.s.start(readReq())
    releaseB()
    const bIds = await b
    releaseA()
    await expect(a).rejects.toThrow('superseded by a newer start')
    expect(t.slot.run?.runId).toBe(bIds.runId)
    await until(() => expect(t.spawnFn).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
  })
})

describe('session — status echo and points', () => {
  it('U-6/U-24: status echoes the run inputs', async () => {
    const t = setup({ pages: [rows(1000, 384), []] })
    const { jobId } = await t.s.start(readReq({ tenant: 't1', filters: F, limit: 5000 }, 3))
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    const scope = t.st(jobId).scope
    expect(scope).toEqual({
      connectionId: 'c',
      collection: 'A',
      tenant: 't1',
      vector: 'vec',
      filters: F,
      method: 'umap',
      dims: 3,
      limit: 5000,
      props: ['title', 'year'],
      dim: 384,
      metric: 'cosine'
    })
    expect(scopeSchema.safeParse(scope).success).toBe(true)
    expect(t.deps.getCollection).toHaveBeenCalledWith('c', 'A', 't1')
  })

  it('D-21: points carry every prefetched column', async () => {
    const t = setup({ pages: [rows(50)] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    const pts = t.st(jobId, { points: true }).points!
    expect(pts.props).toEqual(['title', 'year'])
    expect(pts.columns.map((c) => c.length)).toEqual([50, 50])
    expect(pts.columns[1].every((v) => typeof v === 'number')).toBe(true)
  })

  it('U-24: a selection\'s scope keeps the root filters', async () => {
    const t = setup()
    const root = await rootRun(t, 100)
    const { jobId } = await t.s.start(selReq(root.jobId, range(20), 2))
    expect(t.st(jobId).scope).toMatchObject({ filters: F, selection: 20, dims: 2, dim: 4 })
  })

  it('U-39: should answer points for the requested level', async () => {
    const t = setup()
    const l1 = await rootRun(t, 2000)
    const sel = range(20, 100)
    const l2 = await selection(t, l1.jobId, sel, 5)
    const p1 = t.st(l1.jobId, { points: true, runId: l1.runId }).points!
    expect(p1.uuids.length).toBe(2000)
    expect(p1.runId).toBe(l1.runId)
    const p2 = t.st(l1.jobId, { points: true, runId: l2.runId }).points!
    expect(p2.uuids).toEqual(sel.map((i) => `u${i}`))
    expect(p2.indices).toEqual(sel)
    expect(t.st(l1.jobId, { points: true, runId: 'gone' }).points).toBeUndefined()
  })

  it('U-39: should answer points for a run that has no context yet', async () => {
    const t = setup()
    const l1 = await rootRun(t, 100)
    const sel = range(16, 30)
    const l2 = await t.s.start(selReq(l1.jobId, sel))
    expect(t.slot.contexts.has(l2.runId)).toBe(false)
    const pts = t.st(l1.jobId, { points: true, runId: l2.runId }).points!
    expect(pts.uuids).toEqual(sel.map((i) => `u${i}`))
    expect(pts.runId).toBe(l2.runId)
  })

  it('U-37: should add the Euclidean-layout notice for manhattan', async () => {
    const t = setup({ distance: 'manhattan', pages: [deferred()] })
    const { jobId } = await t.s.start(readReq())
    expect(t.st(jobId).notice).toMatch(/^manhattan metric: Euclidean layout/)
    const l2 = setup({ distance: 'l2-squared', pages: [deferred()] })
    const r = await l2.s.start(readReq())
    expect(l2.st(r.jobId).notice).toBeUndefined()
  })

  it('U-20: should add the Euclidean-layout notice for dot', async () => {
    const t = setup({ distance: 'dot', pages: [deferred()] })
    const { jobId } = await t.s.start(readReq())
    expect(t.st(jobId).notice).toMatch(/^dot metric: Euclidean layout/)
  })
})

describe('session — placement contexts', () => {
  const q = { kind: 'vector' as const, vector: [6, 6, 6, 6] }

  it('U-2: should place a query with the requested run\'s basis after drilling down', async () => {
    const t = setup({ distance: 'l2-squared' }) // raw query: under cosine it would be normalised first
    const l1 = await rootRun(t, 100, 0)
    const l2 = await selection(t, l1.jobId, range(20), 5)
    const r = t.s.placeQuery({ jobId: l1.jobId, runId: l2.runId, view: 'pca', query: q })
    expect(r).toMatchObject({ placed: true, coords: [1, 1, 1], method: 'basis' })
  })

  it('U-22: should place in level 1\'s basis after a level-2 selection', async () => {
    const t = setup({ distance: 'l2-squared' })
    const l1 = await rootRun(t, 100, 0)
    const l2 = await selection(t, l1.jobId, range(20), 5)
    const r1 = t.s.placeQuery({ jobId: l1.jobId, runId: l1.runId, view: 'pca', query: q })
    const r2 = t.s.placeQuery({ jobId: l1.jobId, runId: l2.runId, view: 'pca', query: q })
    expect(r1.coords).toEqual([6, 6, 6])
    expect(r1.coords).not.toEqual(r2.coords)
  })

  it('U-22: should refuse an unknown runId', async () => {
    const t = setup()
    const l1 = await rootRun(t, 100)
    expect(t.s.placeQuery({ jobId: l1.jobId, runId: 'gone', view: 'pca', query: q })).toEqual({
      placed: false,
      reason: 'run not available',
      approximate: false
    })
  })

  it('F-16: should not project the dataset per query', async () => {
    const t = setup()
    const l1 = await rootRun(t, 100)
    const req = { jobId: l1.jobId, runId: l1.runId, view: 'umap' as const, query: { kind: 'vector' as const, vector: vec(7, 4) } }
    const before = t.s.placeQuery(req)
    expect(before.placed).toBe(true)
    t.slot.dataset!.vectors = new Float32Array(0)
    expect(t.s.placeQuery(req)).toEqual(before)
    expect(t.s.placeQuery(req)).toEqual(before)
  })

  it('F-17: should drop the previous dataset on a new start', async () => {
    const t = setup()
    const a = await rootRun(t, 100)
    const aVectors = t.slot.dataset!.vectors
    t.script.push(rows(50))
    const b = await t.s.start(readReq())
    await until(() => expect(t.slot.dataset?.jobId).toBe(b.jobId))
    expect(t.slot.contexts.has(a.runId)).toBe(false)
    expect(references(t.slot, aVectors.buffer)).toBe(false)
  })
})

/** Whether any typed array reachable from `root` (child processes aside) views `buf`. */
function references(root: unknown, buf: ArrayBufferLike, seen = new Set<unknown>()): boolean {
  if (typeof root !== 'object' || root === null || seen.has(root)) return false
  seen.add(root)
  if (ArrayBuffer.isView(root)) return root.buffer === buf
  if (root instanceof EventEmitter) return false
  const values = root instanceof Map ? [...root.values()] : Object.values(root)
  return values.some((v) => references(v, buf, seen))
}
