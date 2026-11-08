import { describe, expect, it } from 'vitest'
import type { PlaceQueryRequest, ProjectionQuery, ProjectionScope } from '@shared/types'
import { isApproximate, placeExactPca, placeHits, placeKnn, placeQuery, type Basis, type PlacementContext } from './place'
import { createRun, toPlacementContext } from './run'

const basisOf = (mean: number[], comps: number[][]): Basis => ({
  mean: Float32Array.from(mean),
  components: Float32Array.from(comps.flat()),
  p: comps.length,
  d: mean.length
})
const identity = (p: number, d: number): number[][] =>
  Array.from({ length: p }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? 1 : 0)))

/** A context over `rows` with a hand-built basis; pca50 is projected in f32, like the sidecar's. */
function ctxOf(rows: number[][], basis: Basis, umap?: number[][]): PlacementContext {
  const n = rows.length
  const pca50 = new Float32Array(n * basis.p)
  const pca = new Float32Array(n * 3)
  rows.forEach((r, i) => {
    for (let k = 0; k < basis.p; k++) {
      let s = 0
      for (let j = 0; j < basis.d; j++) s += (r[j] - basis.mean[j]) * basis.components[k * basis.d + j]
      pca50[i * basis.p + k] = s
      if (k < 3) pca[i * 3 + k] = s
    }
  })
  const dims = (umap?.[0]?.length ?? 2) as 2 | 3
  return {
    runId: 'r1',
    basis,
    pca50,
    p: basis.p,
    n,
    pca,
    umap: umap && { coords: Float32Array.from(umap.flat()), dims },
    uuidIndex: new Map(rows.map((_, i) => [`u${i}`, i]))
  }
}
const req = (view: 'pca' | 'umap', query: ProjectionQuery): PlaceQueryRequest => ({ jobId: 'j', runId: 'r1', view, query })
const line = (n: number): number[][] => Array.from({ length: n }, (_, i) => [i, 0])
const view2 = (pts: number[][]): Float32Array => Float32Array.from(pts.flat())

describe('placeExactPca', () => {
  it('U-53: placeExactPca always returns 3 coordinates', () => {
    const small = placeExactPca(basisOf([0, 0, 0], identity(2, 3)), Float32Array.from([1, 2, 3]))
    expect(small).toEqual([1, 2, 0])
    const big = placeExactPca(basisOf(new Array(64).fill(0), identity(50, 64)), new Float32Array(64).fill(1))
    expect(big).toHaveLength(3)
  })
})

describe('placeQuery — kinds and views', () => {
  const rows = Array.from({ length: 20 }, (_, i) => [i, (i * 7) % 5, (i * 3) % 4])
  const umap = rows.map((_, i) => [i * 2, -i])
  const ctx = ctxOf(rows, basisOf([1, 1, 1], identity(3, 3)), umap)

  it('U-21: approximate per view and kind', () => {
    const vec: ProjectionQuery = { kind: 'vector', vector: [3, 1, 2] }
    const hits: ProjectionQuery = { kind: 'hits', metric: 'score', hits: [{ uuid: 'u1', score: 1 }] }
    expect(placeQuery(ctx, req('umap', vec), 'l2-squared')).toMatchObject({ approximate: true, method: 'knn' })
    expect(placeQuery(ctx, req('pca', vec), 'l2-squared')).toMatchObject({ approximate: false, method: 'basis' })
    const obj = placeQuery(ctx, req('umap', { kind: 'object', uuid: 'u4' }), 'l2-squared')
    expect(obj).toEqual({ placed: true, coords: [8, -4], approximate: false, method: 'point' })
    expect(placeQuery(ctx, req('pca', hits), 'l2-squared')).toMatchObject({ approximate: true, method: 'centroid' })
    expect([isApproximate('pca', 'vector'), isApproximate('umap', 'object'), isApproximate('pca', 'hits')]).toEqual([
      false,
      false,
      true
    ])
  })

  it('should refuse a UMAP placement before the first frame', () => {
    const noUmap = { ...ctx, umap: undefined }
    const r = placeQuery(noUmap, req('umap', { kind: 'object', uuid: 'u1' }), 'cosine')
    expect(r).toMatchObject({ placed: false, reason: 'view not ready' })
  })

  it('U-11: should place a query at the matching point when its distance is 0', () => {
    const angle = Math.PI / 6
    const rot = [
      [Math.cos(angle), Math.sin(angle), 0],
      [-Math.sin(angle), Math.cos(angle), 0],
      [0, 0, 1]
    ]
    const c = ctxOf(rows, basisOf([0.3, -0.2, 0.1], rot), umap)
    const r = placeQuery(c, req('umap', { kind: 'vector', vector: rows[7] }), 'l2-squared')
    expect(r.placed).toBe(true)
    r.coords!.forEach((x, k) => expect(Math.abs(x - umap[7][k])).toBeLessThan(1e-4))

    // An exact match (d = 0, no rounding) takes the mean of the zero-distance points, not 1/0 weights.
    const exactCtx = ctxOf(rows, basisOf([0, 0, 0], identity(3, 3)), umap)
    const e = placeQuery(exactCtx, req('umap', { kind: 'vector', vector: rows[7] }), 'l2-squared')
    expect(e.coords).toEqual(umap[7])
  })

  it('U-20: should normalise a cosine query before placement', () => {
    const unit = Array.from({ length: 20 }, (_, i) => {
      const v = [Math.cos(i), Math.sin(i), 0.5]
      const nrm = Math.hypot(...v)
      return v.map((x) => x / nrm)
    })
    const c = ctxOf(unit, basisOf([0.1, 0.1, 0.4], identity(3, 3)), umap)
    for (const view of ['pca', 'umap'] as const) {
      const a = placeQuery(c, req(view, { kind: 'vector', vector: [2, 0, 0] }), 'cosine')
      const b = placeQuery(c, req(view, { kind: 'vector', vector: [1, 0, 0] }), 'cosine')
      expect(a.coords).toEqual(b.coords)
    }
  })

  it('F-15: should reject a query vector whose length differs from the basis', () => {
    const c: PlacementContext = { ...ctx, basis: basisOf(new Array(384).fill(0), identity(3, 384)) }
    const r = placeQuery(c, req('pca', { kind: 'vector', vector: new Array(128).fill(1) }), 'cosine')
    expect(r).toMatchObject({ placed: false, reason: 'dimension 128, expected 384' })
  })
})

describe('placeKnn', () => {
  it('should break a rank-k tie toward the lower index', () => {
    // q is 1 away from rows 1 and 2; k = 1 keeps row 1 only.
    const pca50 = Float32Array.from([10, 0, 0, 1, 0, -1])
    const view = view2([[100, 0], [1, 1], [2, 2]])
    const out = placeKnn({ pca50, p: 2, view, dims: 2, n: 3 }, Float32Array.from([0, 0]), 1)
    expect(out).toEqual([1, 1])
  })
})

describe('placeHits — weights', () => {
  const idx = new Map([['a', 0], ['b', 1]])
  const view = view2([[0, 0], [10, 0]])
  const x = (r: ReturnType<typeof placeHits>): number => r.coords![0]

  it('U-10: should weight nearText hits by 1-distance and bm25 hits by score', () => {
    const near = placeHits([{ uuid: 'a', distance: 0.1 }, { uuid: 'b', distance: 0.9 }], 'distance', 'cosine', idx, view, 2)
    expect(x(near)).toBeCloseTo(1.0, 5)
    expect(near.method).toBe('centroid')
    const bm25 = placeHits([{ uuid: 'a', score: 0 }, { uuid: 'b', score: 0 }], 'score', 'cosine', idx, view, 2)
    expect(x(bm25)).toBe(5)
    expect(bm25.method).toBe('mean')
  })

  it('U-20: should weight l2 hits rank-safely', () => {
    const r = placeHits([{ uuid: 'a', distance: 4 }, { uuid: 'b', distance: 16 }], 'distance', 'l2-squared', idx, view, 2)
    expect(Math.abs(x(r))).toBeLessThan(1e-4)
    expect(r.method).toBe('centroid')
  })

  it('U-32: should give positive, ordered weights to negative dot distances', () => {
    const r = placeHits([{ uuid: 'a', distance: -10 }, { uuid: 'b', distance: -2 }], 'distance', 'dot', idx, view, 2)
    // Both weights > 0 → strictly inside the segment; w₀ > w₁ → nearer the first hit.
    expect(x(r)).toBeGreaterThan(0)
    expect(x(r)).toBeLessThan(5)
  })

  it('U-32: should stay finite near zero', () => {
    const r = placeHits([{ uuid: 'a', distance: -1e-7 }, { uuid: 'b', distance: -5 }], 'distance', 'dot', idx, view, 2)
    r.coords!.forEach((c) => expect(Number.isFinite(c)).toBe(true))
  })

  it('U-12: centre on present hits only', () => {
    const pts = line(14)
    const index = new Map(pts.map((_, i) => [`p${i}`, i]))
    const hits = [
      ...pts.map((_, i) => ({ uuid: `p${i}`, score: 1 })),
      ...Array.from({ length: 6 }, (_, i) => ({ uuid: `gone${i}`, score: 100 }))
    ]
    const r = placeHits(hits, 'score', 'cosine', index, view2(pts), 2)
    expect(r).toMatchObject({ placed: true, inView: 14, total: 20 })
    expect(x(r)).toBeCloseTo(6.5, 6)
    const none = placeHits([{ uuid: 'gone', score: 1 }], 'score', 'cosine', index, view2(pts), 2)
    expect(none).toMatchObject({ placed: false, reason: 'no hits in this projection' })
  })
})

describe('U-33: selection-local indexing', () => {
  const rootUuids = Array.from({ length: 40 }, (_, i) => `root${i}`)
  const scope = {} as ProjectionScope
  const run = createRun({ runId: 'sel', jobId: 'j', kind: 'selection', indices: Uint32Array.from([10, 20, 30]), method: 'pca', dims: 2, scope })
  run.basis = basisOf([0, 0], identity(2, 2))
  run.pca50 = Float32Array.from([1, 1, 2, 2, 3, 3])
  run.pca = Float32Array.from([1, 1, 0, 2, 2, 0, 3, 3, 0])
  run.pcaRows = 3
  const ctx = toPlacementContext(run, rootUuids)!

  it('U-33: should index a selection\'s points locally', () => {
    const r = placeQuery(ctx, { jobId: 'j', runId: 'sel', view: 'pca', query: { kind: 'hits', metric: 'score', hits: [{ uuid: 'root20', score: 1 }] } }, 'cosine')
    expect(r).toMatchObject({ placed: true, inView: 1, total: 1, coords: [2, 2, 0] })
  })

  it('U-33: should refuse an object outside the selection', () => {
    const r = placeQuery(ctx, { jobId: 'j', runId: 'sel', view: 'pca', query: { kind: 'object', uuid: 'root5' } }, 'cosine')
    expect(r).toMatchObject({ placed: false, reason: 'point not in this selection' })
  })
})
