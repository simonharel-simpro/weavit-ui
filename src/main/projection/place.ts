// Query placement in a run's frame (U-21). Pure: only the query is projected,
// never the dataset (F-16). The PCA view keeps stride 3 in 2D and 3D (U-53).
import { NN_DEFAULT } from '@shared/projection'
import type { PlaceQueryRequest, PlaceQueryResult, ProjectionQuery, VectorMetric } from '@shared/types'

export interface Basis {
  mean: Float32Array
  /** p×d row-major */
  components: Float32Array
  p: number
  d: number
}
export interface PlacementContext {
  runId: string
  basis: Basis
  pca50: Float32Array
  p: number
  n: number
  /** n×3 */
  pca: Float32Array
  umap?: { coords: Float32Array; dims: 2 | 3 }
  uuidIndex: Map<string, number>
  /** Root indices of a selection; absent for the root run. */
  indices?: Uint32Array
}

const EPS = 1e-6
type Hit = { uuid: string; distance?: number; score?: number }

export function isApproximate(view: 'pca' | 'umap', kind: ProjectionQuery['kind']): boolean {
  return !(view === 'pca' && kind === 'vector') && kind !== 'object'
}

/** components · (q − mean), all p coordinates. */
function project(basis: Basis, q: ArrayLike<number>): Float64Array {
  const out = new Float64Array(basis.p)
  for (let k = 0; k < basis.p; k++) {
    let s = 0
    const row = k * basis.d
    for (let j = 0; j < basis.d; j++) s += (q[j] - basis.mean[j]) * basis.components[row + j]
    out[k] = s
  }
  return out
}

export function placeExactPca(basis: Basis, q: Float32Array): [number, number, number] {
  const c = project(basis, q)
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]
}

const point = (view: ArrayLike<number>, i: number, dims: number): number[] =>
  Array.from({ length: dims }, (_, k) => view[i * dims + k])

function weightedMean(view: ArrayLike<number>, dims: number, idx: number[], w: number[]): number[] {
  const out = new Array<number>(dims).fill(0)
  let total = 0
  idx.forEach((i, h) => {
    total += w[h]
    for (let k = 0; k < dims; k++) out[k] += w[h] * view[i * dims + k]
  })
  return out.map((x) => x / total)
}

/** Inverse-distance mean of the k nearest rows in PCA-p space; d = 0 → mean of the exact matches (U-11). */
export function placeKnn(
  a: { pca50: Float32Array; p: number; view: Float32Array; dims: 2 | 3; n: number },
  q50: ArrayLike<number>,
  k: number = NN_DEFAULT
): number[] {
  const dist = new Float64Array(a.n)
  for (let i = 0; i < a.n; i++) {
    let s = 0
    for (let j = 0; j < a.p; j++) s += (a.pca50[i * a.p + j] - q50[j]) ** 2
    dist[i] = Math.sqrt(s)
  }
  // Stable sort on the index order: rank-k ties go to the lower index.
  const near = Array.from({ length: a.n }, (_, i) => i)
    .sort((x, y) => dist[x] - dist[y] || x - y)
    .slice(0, Math.min(k, a.n))
  const exact = near.filter((i) => dist[i] === 0)
  if (exact.length > 0) return weightedMean(a.view, a.dims, exact, exact.map(() => 1))
  return weightedMean(a.view, a.dims, near, near.map((i) => 1 / dist[i]))
}

/** U-10, U-32: always-positive, rank-preserving weights for in-view hits. */
function hitWeights(hits: Hit[], metric: 'distance' | 'score', vectorMetric: VectorMetric): number[] {
  // A hit without the field it is ranked by carries no weight.
  if (metric === 'score') return hits.map((h) => Math.max(0, h.score ?? 0))
  if (vectorMetric === 'cosine') return hits.map((h) => (h.distance === undefined ? 0 : Math.max(EPS, 1 - h.distance)))
  const ds = hits.map((h) => h.distance).filter((d): d is number => d !== undefined)
  const dMax = Math.max(...ds)
  return hits.map((h) => (h.distance === undefined ? 0 : dMax - h.distance + EPS))
}

export function placeHits(
  hits: Hit[],
  metric: 'distance' | 'score',
  vectorMetric: VectorMetric,
  uuidIndex: Map<string, number>,
  view: Float32Array,
  dims: 2 | 3
): PlaceQueryResult {
  const present = hits.filter((h) => uuidIndex.has(h.uuid))
  const counts = { inView: present.length, total: hits.length }
  if (present.length === 0) {
    return { placed: false, reason: 'no hits in this projection', approximate: true, ...counts }
  }
  const idx = present.map((h) => uuidIndex.get(h.uuid) as number)
  const w = hitWeights(present, metric, vectorMetric)
  if (w.every((x) => x <= 0)) {
    const coords = weightedMean(view, dims, idx, idx.map(() => 1))
    return { placed: true, coords, approximate: true, method: 'mean', ...counts }
  }
  return { placed: true, coords: weightedMean(view, dims, idx, w), approximate: true, method: 'centroid', ...counts }
}

function placeVector(ctx: PlacementContext, req: PlaceQueryRequest, v: number[], metric: VectorMetric): PlaceQueryResult {
  const approximate = isApproximate(req.view, 'vector')
  if (v.length !== ctx.basis.d) {
    return { placed: false, reason: `dimension ${v.length}, expected ${ctx.basis.d}`, approximate }
  }
  let q = Float32Array.from(v)
  if (metric === 'cosine') {
    const norm = Math.hypot(...q)
    if (norm === 0) return { placed: false, reason: 'a zero vector has no cosine direction', approximate }
    q = q.map((x) => x / norm)
  }
  if (req.view === 'pca') return { placed: true, coords: placeExactPca(ctx.basis, q), approximate, method: 'basis' }
  const umap = ctx.umap as NonNullable<PlacementContext['umap']>
  const a = { pca50: ctx.pca50, p: ctx.p, view: umap.coords, dims: umap.dims, n: ctx.n }
  return { placed: true, coords: placeKnn(a, project(ctx.basis, q)), approximate, method: 'knn' }
}

export function placeQuery(ctx: PlacementContext, req: PlaceQueryRequest, vectorMetric: VectorMetric): PlaceQueryResult {
  const { query } = req
  const approximate = isApproximate(req.view, query.kind)
  if (req.view === 'umap' && !ctx.umap) return { placed: false, reason: 'view not ready', approximate }
  const view = req.view === 'umap' && ctx.umap ? ctx.umap.coords : ctx.pca
  const dims = req.view === 'umap' && ctx.umap ? ctx.umap.dims : 3
  if (query.kind === 'vector') return placeVector(ctx, req, query.vector, vectorMetric)
  if (query.kind === 'hits') return placeHits(query.hits, query.metric, vectorMetric, ctx.uuidIndex, view, dims)
  const i = ctx.uuidIndex.get(query.uuid)
  if (i === undefined) return { placed: false, reason: 'point not in this selection', approximate }
  return { placed: true, coords: point(view, i, dims), approximate, method: 'point' }
}
