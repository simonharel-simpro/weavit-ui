/** Shared fakes, fixtures and helpers for the session.*.test.ts suites (not a test file itself). */
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { expect, vi } from 'vitest'
import type { CollectionConfig, FilterNode, ProjectionStartRequest, ProjectionStatusKnown } from '@shared/types'
import { encodeF32 } from './protocol'
import type { RawObject } from './readVectors'
import { createProjectionSession, type ProjectionSession, type SessionDeps } from './session'
import type { SpawnFn } from './sidecar'
import { createSlot, type Slot } from './state'

export class FakeChild extends EventEmitter {
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

export type Deferred = { promise: Promise<RawObject[]>; resolve(v: RawObject[]): void; reject(e: Error): void }
/** Every page `deferred` creates, so `disposeSessions` can settle the ones a test left pending. */
const pending: Deferred[] = []
export const deferred = (): Deferred => {
  let resolve!: (v: RawObject[]) => void
  let reject!: (e: Error) => void
  const promise = new Promise<RawObject[]>((res, rej) => ((resolve = res), (reject = rej)))
  const d = { promise, resolve, reject }
  pending.push(d)
  return d
}
export type Page = RawObject[] | Error | Deferred

export const vec = (i: number, d: number): number[] => Array.from({ length: d }, (_, j) => ((i * 7 + j * 3) % 11) + 1)
export const rows = (count: number, d = 4, start = 0): RawObject[] =>
  Array.from({ length: count }, (_, k) => ({
    uuid: `u${start + k}`,
    properties: { title: `t${start + k}`, year: start + k },
    vectors: { vec: vec(start + k, d) }
  }))
/** `count` rows as full pages (an empty page ends the read). */
export const pagesOf = (count: number, d = 4): Page[] =>
  Array.from({ length: Math.ceil(count / 1000) }, (_, i) => rows(Math.min(1000, count - i * 1000), d, i * 1000))

export const F: FilterNode[] = [{ property: 'year', operator: 'GreaterThan', value: '1', valueType: 'int' }]
export const builtF = { prop: 'year', op: 'greaterThan', value: 1 }
export const config = (distance = 'cosine'): CollectionConfig => ({
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
export const readReq = (over: Partial<ProjectionStartRequest['source']> = {}, dims: 2 | 3 = 2): ProjectionStartRequest => ({
  source: { kind: 'read', connectionId: 'c', collection: 'A', vector: 'vec', limit: 100_000, ...over } as ProjectionStartRequest['source'],
  method: 'umap',
  dims
})
export const selReq = (jobId: string, indices: number[], dims: 2 | 3 = 2): ProjectionStartRequest => ({
  source: { kind: 'selection', jobId, indices },
  method: 'umap',
  dims
})
export const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => from + i)
export const enc = (a: number[]): string => encodeF32(Float32Array.from(a))
export const identity = (p: number, d: number): number[] =>
  Array.from({ length: p * d }, (_, k) => (Math.floor(k / d) === k % d ? 1 : 0))

/** Every session `setup` creates; each suite's `afterEach` disposes them all via `disposeSessions`. */
const sessions: ProjectionSession[] = []
/**
 * Dispose every session, then end every page a test left pending. Disposal alone leaves the
 * read awaiting its page, and with it the 30 s page-timeout timer; an empty page (a no-op if
 * the test already settled it) ends the now-cancelled read and clears that timer.
 */
export function disposeSessions(): void {
  for (const s of sessions.splice(0)) s.dispose()
  for (const d of pending.splice(0)) d.resolve([])
}

export function setup(o: { pages?: Page[]; stall?: boolean; distance?: string; overAll?: () => Promise<{ totalCount?: number }>; stat?: SessionDeps['stat'] } = {}) {
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
  const s = createProjectionSession(deps, slot)
  sessions.push(s)
  const st = (jobId: string, opts = {}) => s.status(jobId, opts) as ProjectionStatusKnown
  return { s, slot, deps, children, spawnFn, fetchObjects, fetchesAtSpawn, overAll, st, script }
}

/** Basis (mean `mean`, identity components), the PCA rows, pca50 = rows − mean. */
export function emitPca(child: FakeChild, n: number, d: number, mean: number, src: (i: number) => number[] = (i) => vec(i, d)) {
  child.out({ type: 'basis', mean: enc(new Array(d).fill(mean)), components: enc(identity(d, d)), pcaDims: d })
  child.out({ type: 'pcaChunk', offset: 0, count: n, coords: enc(range(n).flatMap((i) => src(i).slice(0, 3).map((x) => x - mean))) })
  child.out({ type: 'pca50', n, pcaDims: d, coords: enc(range(n).flatMap((i) => src(i).map((x) => x - mean))) })
}
export const emitFrame = (child: FakeChild, n: number, epoch: number) =>
  child.out({ type: 'frame', stage: 'umap', epoch, epochs: 200, dims: 2, n, coords: enc(range(n).flatMap((i) => [i, -i])) })
export const finish = (child: FakeChild, n: number) => {
  child.out({ type: 'done', n })
  child.exit(0)
}
export const until = (f: () => void) => vi.waitFor(f, { timeout: 2000 })

/** A complete root read of `n` rows that reached pca50 with basis mean `mean`, finished. */
export async function rootRun(t: ReturnType<typeof setup>, n: number, mean = 0) {
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
export async function selection(t: ReturnType<typeof setup>, jobId: string, indices: number[], mean: number, dims: 2 | 3 = 2) {
  const ids = await t.s.start(selReq(jobId, indices, dims))
  await until(() => expect(t.slot.run?.state).toBe('computing'))
  emitPca(t.children.at(-1)!, indices.length, 4, mean, (i) => vec(indices[i], 4))
  return ids
}

/** Whether any typed array reachable from `root` (child processes aside) views `buf`. */
export function references(root: unknown, buf: ArrayBufferLike, seen = new Set<unknown>()): boolean {
  if (typeof root !== 'object' || root === null || seen.has(root)) return false
  seen.add(root)
  if (ArrayBuffer.isView(root)) return root.buffer === buf
  if (root instanceof EventEmitter) return false
  const values = root instanceof Map ? [...root.values()] : Object.values(root)
  return values.some((v) => references(v, buf, seen))
}
