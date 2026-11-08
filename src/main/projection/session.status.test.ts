import { afterEach, describe, expect, it } from 'vitest'
import { scopeSchema } from './validate'
import { deferred, disposeSessions, F, range, readReq, references, rootRun, rows, selection, selReq, setup, until, vec } from './session.fixtures'

afterEach(disposeSessions)

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
