// Run state transitions: host events (pages, read end, cancel) and sidecar
// messages/outcome move one Run; toStatus renders it for the renderer.
import { decodeF32 } from '@shared/projection'
import type { ProjectionMethod, ProjectionScope, ProjectionStatusKnown, ProjectionStatusOptions } from '@shared/types'
import type { PlacementContext } from './place'
import { encodeF32, type SidecarMessage } from './protocol'
import type { SidecarOutcome } from './sidecar'
import type { Dataset, Run } from './state'

const active = (run: Run): boolean => run.state === 'reading' || run.state === 'computing'

export function createRun(a: {
  runId: string
  jobId: string
  kind: 'read' | 'selection'
  indices?: Uint32Array
  method: ProjectionMethod
  dims: 2 | 3
  scope: ProjectionScope
  notice?: string
}): Run {
  const selection = a.kind === 'selection'
  return {
    ...a,
    state: 'reading',
    stage: 'reading',
    progress: selection ? { done: 0, total: a.indices?.length ?? 0 } : { done: 0 },
    n: 0,
    frameVersion: 0,
    cancelled: false,
    // A selection's rows come from the complete dataset.
    readComplete: selection,
    rowsStreamed: 0,
    pcaRows: 0
  }
}

/** `onPage(rows, count)`: rows written to the sidecar. */
export function applyPage(run: Run, count: number): void {
  run.rowsStreamed += count
  run.n = run.rowsStreamed
  if (run.state === 'reading' && run.progress) run.progress.done = run.rowsStreamed
}

/** The read (or the selection's row write) ended: close stdin and start computing. */
export function endRead(run: Run): void {
  run.sidecar?.end()
  if (run.kind === 'read') run.readComplete = !run.cancelled
  if (run.state !== 'reading') return
  run.state = 'computing'
  const cp = run.computeProgress
  run.stage = cp ? cp.stage : 'pca'
  if (cp) run.progress = { done: cp.done, total: cp.total }
}

/** U-15: keeps the last frame, the stage and the progress; no-op after a terminal state. */
export function cancelRun(run: Run, state: 'cancelled' | 'superseded' = 'cancelled'): void {
  if (!active(run)) return
  run.cancelled = true
  run.state = state
  run.sidecar?.kill(state)
}

function storePca(run: Run, offset: number, count: number, coords: Float32Array): void {
  const need = (offset + count) * 3
  if (!run.pca || run.pca.length < need) {
    const grown = new Float32Array(Math.max(need, (run.pca?.length ?? 0) * 2))
    if (run.pca) grown.set(run.pca)
    run.pca = grown
  }
  run.pca.set(coords, offset * 3)
  run.pcaRows = Math.max(run.pcaRows, offset + count)
}

export function applyMessage(run: Run, m: SidecarMessage): void {
  switch (m.type) {
    case 'progress':
      run.computeProgress = { stage: m.stage, done: m.done, total: m.total }
      // While reading, the visible stage stays 'reading' (pca progress arrives during the read).
      if (run.state === 'computing') {
        run.stage = m.stage
        run.progress = { done: m.done, total: m.total }
      }
      return
    case 'basis': {
      const mean = decodeF32(m.mean)
      run.basis = { mean, components: decodeF32(m.components), p: m.pcaDims, d: mean.length }
      return
    }
    case 'pcaChunk':
      storePca(run, m.offset, m.count, decodeF32(m.coords))
      run.frameVersion++
      return
    case 'pca50':
      run.pca50 = decodeF32(m.coords)
      return
    case 'frame':
      run.umap = { coords: decodeF32(m.coords), epoch: m.epoch, epochs: m.epochs, dims: m.dims }
      run.frameVersion++
      if (run.state === 'computing') {
        run.stage = 'epochs'
        run.progress = { done: m.epoch, total: m.epochs }
      }
      return
    case 'notice':
      run.notice = run.notice ? `${run.notice}; ${m.message}` : m.message
      return
    default:
      // hello is checked in sidecar.ts; done/error are recorded there and decided at close.
      return
  }
}

export function applyOutcome(run: Run, o: SidecarOutcome): void {
  if (!active(run)) return
  if (o.ok) {
    run.state = 'done'
    run.n = o.n
    if (run.progress?.total !== undefined) run.progress.done = run.progress.total
  } else {
    run.state = 'failed'
    run.error = o.error
  }
}

/** U-33: `uuids` is always the root list; the index is level-local. */
export function toPlacementContext(run: Run, uuids: string[]): PlacementContext | undefined {
  const { basis, pca50, pca } = run
  if (!basis || !pca50 || !pca) return undefined
  const n = pca50.length / basis.p
  const ix = run.indices
  const uuidIndex = new Map<string, number>()
  for (let i = 0; i < n; i++) uuidIndex.set(uuids[ix ? ix[i] : i], i)
  return {
    runId: run.runId,
    basis,
    pca50,
    p: basis.p,
    n,
    pca: pca.subarray(0, run.pcaRows * 3),
    umap: run.umap && { coords: run.umap.coords, dims: run.umap.dims },
    uuidIndex,
    indices: ix
  }
}

/** U-39: points of the run `o.runId` names (default: the current run). */
function points(run: Run, ds: Dataset | undefined, o: ProjectionStatusOptions, contexts: ReadonlyMap<string, PlacementContext>) {
  if (!o.points || !ds) return undefined
  const current = o.runId === undefined || o.runId === run.runId
  const ctx = current ? undefined : contexts.get(o.runId as string)
  if (!current && !ctx) return undefined
  const ix = current ? run.indices : ctx?.indices
  const pick = <T>(col: T[]): T[] => (ix ? Array.from(ix, (i) => col[i]) : col)
  return {
    uuids: pick(ds.uuids),
    props: ds.props,
    columns: ds.values.map(pick),
    ...(ix ? { indices: Array.from(ix) } : {}),
    runId: current ? run.runId : (o.runId as string)
  }
}

export function toStatus(
  run: Run,
  ds: Dataset | undefined,
  o: ProjectionStatusOptions,
  contexts: ReadonlyMap<string, PlacementContext>
): ProjectionStatusKnown {
  const s: ProjectionStatusKnown = {
    jobId: run.jobId,
    runId: run.runId,
    state: run.state,
    scope: run.scope,
    n: run.n,
    readComplete: run.readComplete,
    frameVersion: run.frameVersion
  }
  if (run.stage) s.stage = run.stage
  if (run.progress) s.progress = { ...run.progress }
  if (ds) s.skipped = { ...ds.skipped }
  if (ds?.capReason) s.cap = { read: ds.n, matched: ds.matched, reason: ds.capReason }
  if (run.notice) s.notice = run.notice
  if (run.error) s.error = run.error
  if (run.frameVersion > (o.since ?? -1)) {
    // U-45: only the rows the pcaChunks covered; the renderer counts coords.length / 3.
    if (run.pca && run.pcaRows > 0) s.pca = encodeF32(run.pca.subarray(0, run.pcaRows * 3))
    if (run.umap) s.umap = { coords: encodeF32(run.umap.coords), epoch: run.umap.epoch, epochs: run.umap.epochs, dims: run.umap.dims }
  }
  const p = points(run, ds, o, contexts)
  if (p) s.points = p
  return s
}
