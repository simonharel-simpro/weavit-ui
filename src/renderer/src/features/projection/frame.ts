import { decodeF32 } from '@shared/projection'
import type {
  ProjectionMethod,
  ProjectionScope,
  ProjectionStatus,
  ProjectionStatusKnown
} from '@shared/types'

type Points = NonNullable<ProjectionStatusKnown['points']>

const TERMINAL: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'cancelled',
  'superseded',
  'empty',
  'unknown'
])
const POLL_MS = 500
/** The PCA frame and the placeQuery marker always carry three components. */
const PCA_STRIDE = 3

/** `ProjectionStatus` is known unless the host no longer has the job. */
export function isKnown(s: ProjectionStatus | undefined): s is ProjectionStatusKnown {
  return s !== undefined && s.state !== 'unknown'
}

export function isTerminal(state?: ProjectionStatus['state']): boolean {
  return state !== undefined && TERMINAL.has(state)
}

/** Stops on a terminal state and on error, so a dead host is not polled forever (F-12). */
export function pollInterval(q: { state: { data?: ProjectionStatus; error: unknown } }): number | false {
  if (q.state.error !== null && q.state.error !== undefined) return false
  return isTerminal(q.state.data?.state) ? false : POLL_MS
}

/** Keeps the coords the host omits when nothing changed, within the same run. */
export function mergeStatus(prev: ProjectionStatus | undefined, next: ProjectionStatus): ProjectionStatus {
  if (!isKnown(prev) || !isKnown(next) || prev.runId !== next.runId) return next
  return { ...next, pca: next.pca ?? prev.pca, umap: next.umap ?? prev.umap }
}

/** A new run always starts from -1 so its first frame is never skipped (U-44). */
export function sinceFor(prevRunId: string | undefined, runId: string | undefined, version: number): number {
  return runId !== prevRunId ? -1 : version
}

/** Points are read once the dataset is complete; a cancelled read keeps what it read (U-51). */
export function pointsEnabled(status?: ProjectionStatus): boolean {
  if (!isKnown(status)) return false
  return status.readComplete || status.state === 'cancelled'
}

export function acceptPoints(s: ProjectionStatus, runId: string | undefined): Points | undefined {
  if (!isKnown(s)) return undefined
  return s.points?.runId === runId ? s.points : undefined
}

export function pcaCount(pca: Float32Array): number {
  return pca.length / PCA_STRIDE
}

export function markerFor(coords: number[], view: ProjectionMethod, dims: 2 | 3): number[] {
  return view === 'pca' ? coords.slice(0, dims) : coords
}

export const decodeCoords = decodeF32

export function pcaView(pca: Float32Array, dims: 2 | 3): Float32Array {
  if (dims === PCA_STRIDE) return pca
  const n = pcaCount(pca)
  const out = new Float32Array(n * dims)
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dims; d++) out[i * dims + d] = pca[i * PCA_STRIDE + d] ?? 0
  }
  return out
}

export function matchesView(
  scope: ProjectionScope,
  view: { connectionId: string; collection: string; tenant?: string }
): boolean {
  return (
    scope.connectionId === view.connectionId &&
    scope.collection === view.collection &&
    scope.tenant === view.tenant
  )
}

export function isStale(
  lastUmapDims: 2 | 3 | undefined,
  wantedDims: 2 | 3,
  method: ProjectionMethod
): boolean {
  return method === 'umap' && lastUmapDims !== undefined && lastUmapDims !== wantedDims
}

export function drawable(coords: Float32Array, dims: 2 | 3): number {
  let count = 0
  for (let i = 0; i + dims <= coords.length; i += dims) {
    let finite = true
    for (let d = 0; d < dims; d++) finite &&= Number.isFinite(coords[i + d])
    if (finite) count++
  }
  return count
}

/** The frame is a snapshot: a delete only marks the point, it never moves the others (U-18). */
export function afterDelete(
  view: { coords: Float32Array; n: number; deleted: ReadonlySet<string> },
  uuid: string
): { coords: Float32Array; n: number; deleted: ReadonlySet<string> } {
  return { coords: view.coords, n: view.n, deleted: new Set([...view.deleted, uuid]) }
}

export interface Frame {
  coords: Float32Array
  n: number
  dims: 2 | 3
  kind: 'pca' | 'umap'
}

/**
 * PCA when the view is PCA or no UMAP frame exists yet; the UMAP frame (at its own dims)
 * otherwise. Switching the view is local: no host call (U-4).
 */
export function chooseFrame(
  decoded: { pca?: Float32Array; umap?: { coords: Float32Array; dims: 2 | 3 } },
  view: ProjectionMethod,
  dims: 2 | 3
): Frame | undefined {
  const { umap, pca } = decoded
  if (view === 'umap' && umap) {
    return { coords: umap.coords, n: umap.coords.length / umap.dims, dims: umap.dims, kind: 'umap' }
  }
  if (!pca) return undefined
  return { coords: pcaView(pca, dims), n: pcaCount(pca), dims, kind: 'pca' }
}
