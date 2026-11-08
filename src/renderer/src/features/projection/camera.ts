/** Fraction of the smaller viewport side the cloud's extent fills. */
const FILL = 0.9

export interface FitView {
  target: [number, number, number]
  /** deck.gl zoom: at zoom 0 one world unit is one pixel. */
  zoom: number
}

/** Bounds of the finite points → camera target and zoom (both Orthographic and Orbit views). */
export function fitView(coords: Float32Array, n: number, dims: 2 | 3, width: number, height: number): FitView {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    let finite = true
    for (let d = 0; d < dims; d++) finite &&= Number.isFinite(coords[i * dims + d])
    if (!finite) continue
    for (let d = 0; d < dims; d++) {
      const v = coords[i * dims + d] as number
      lo[d] = Math.min(lo[d] as number, v)
      hi[d] = Math.max(hi[d] as number, v)
    }
  }
  if (!Number.isFinite(lo[0])) return { target: [0, 0, 0], zoom: 0 }
  const mid = [0, 1, 2].map((d) => (d < dims ? ((lo[d] as number) + (hi[d] as number)) / 2 : 0))
  const ranges = [0, 1, 2].map((d) => (d < dims ? (hi[d] as number) - (lo[d] as number) : 0))
  // 3D: the diagonal, so the cloud stays inside the view whatever the orbit angle.
  const extent = dims === 3 ? Math.hypot(...ranges) : Math.max(...ranges)
  const zoom = extent > 0 ? Math.log2((FILL * Math.min(width, height)) / extent) : 0
  return { target: mid as FitView['target'], zoom }
}
