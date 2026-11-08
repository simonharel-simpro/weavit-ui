// Pure transitions of the drill-down breadcrumb (U-14, U-22, U-27, D-20). The store
// calls these; the panel only executes what `resolveRun` decides.
import type {
  ProjectionMethod,
  ProjectionScope,
  ProjectionStartRequest,
  ProjectionStatus
} from '@shared/types'
import type { BreadcrumbLevel } from '../../store'
import { isEdited, startRequest, type Controls } from './defaults'
import { isKnown } from './frame'

export type Outcome = 'done' | 'failed' | 'cancelled'
export type RunAction =
  | { kind: 'root' }
  | { kind: 'rerunLevel'; index: number }
  | { kind: 'confirmRoot'; levels: number }

/** A level is pushed when its run starts, so a failed child stays visible with its mark (U-27). */
export function pushLevel(levels: BreadcrumbLevel[], level: BreadcrumbLevel): BreadcrumbLevel[] {
  return [...levels, level]
}

export function settleLevel(
  levels: BreadcrumbLevel[],
  runId: string,
  outcome: Outcome,
  extra: { pcaFrame?: string; umapFrame?: string; n?: number } = {}
): BreadcrumbLevel[] {
  return levels.map((l) => (l.runId === runId ? { ...l, ...extra, status: outcome } : l))
}

/** Pops the top level; an in-flight one is returned for cancelling. The root never pops. */
export function back(levels: BreadcrumbLevel[]): { levels: BreadcrumbLevel[]; cancelJobId?: string } {
  const top = levels[levels.length - 1]
  if (levels.length <= 1 || !top) return { levels }
  return { levels: levels.slice(0, -1), ...(top.status === 'running' && { cancelJobId: top.jobId }) }
}

/** Same indices, new run: the stale frames go with the old run. */
export function rerunLevel(
  levels: BreadcrumbLevel[],
  index: number,
  newRunId: string,
  dims?: 2 | 3
): BreadcrumbLevel[] {
  return levels.map((l, i) => {
    if (i !== index) return l
    const { pcaFrame: _p, umapFrame: _u, ...kept } = l
    return { ...kept, runId: newRunId, status: 'running', ...(dims && { dims }) }
  })
}

/** A terminal run state as a level outcome; undefined while the run is still going. */
export function outcomeOf(state: ProjectionStatus['state']): Outcome | undefined {
  switch (state) {
    case 'done':
      return 'done'
    case 'failed':
    case 'empty':
      return 'failed'
    case 'cancelled':
    case 'superseded':
      return 'cancelled'
    default:
      return undefined
  }
}

/** The canvas never draws another level's frame (U-22). */
export function shouldDraw(status: ProjectionStatus | undefined, level: { runId: string } | undefined): boolean {
  return isKnown(status) && level !== undefined && status.runId === level.runId
}

export interface DrawFrames {
  pca?: string
  umap?: { coords: string; dims: 2 | 3 }
}

/** The live frames of the level that owns the status, else the level's stored ones (Back, U-14). */
export function framesToDraw(status: ProjectionStatus | undefined, level: BreadcrumbLevel | undefined): DrawFrames {
  if (isKnown(status) && shouldDraw(status, level)) {
    return {
      ...(status.pca && { pca: status.pca }),
      ...(status.umap && { umap: { coords: status.umap.coords, dims: status.umap.dims } })
    }
  }
  if (!level) return {}
  return {
    ...(level.pcaFrame && { pca: level.pcaFrame }),
    ...(level.umapFrame && { umap: { coords: level.umapFrame, dims: level.dims } })
  }
}

/** `dims` is the current dims control (U-27). */
export function selectionRequest(
  jobId: string,
  rootIndices: number[],
  dims: 2 | 3,
  method: ProjectionMethod = 'umap'
): ProjectionStartRequest {
  return { source: { kind: 'selection', jobId, indices: rootIndices }, method, dims }
}

/** At the root: run it. Below it, only method/dims re-run the level; a root input needs a confirmation (D-20). */
export function runAction(
  levels: BreadcrumbLevel[],
  current: number,
  controls: Controls,
  scope: ProjectionScope
): RunAction {
  if (levels.length <= 1 || current <= 0) return { kind: 'root' }
  const rootEdited = isEdited({ ...controls, method: scope.method, dims: scope.dims }, scope)
  return rootEdited ? { kind: 'confirmRoot', levels: levels.length } : { kind: 'rerunLevel', index: current }
}

export interface RunContext {
  jobId: string | undefined
  levels: BreadcrumbLevel[]
  controls: Controls
  view: { connectionId: string; collection: string; tenant?: string }
}

/**
 * The decision the Run button executes. A re-run keeps `levels` until the new runId is known
 * (`rerunLevel` then replaces the level); declining the root confirmation sends nothing.
 */
export function resolveRun(
  action: RunAction,
  confirmed: boolean | undefined,
  ctx: RunContext
): { request: ProjectionStartRequest | null; levels: BreadcrumbLevel[] } {
  switch (action.kind) {
    case 'root':
      return { request: startRequest(ctx.view, ctx.controls), levels: ctx.levels }
    case 'confirmRoot':
      if (confirmed !== true) return { request: null, levels: ctx.levels }
      return { request: startRequest(ctx.view, ctx.controls), levels: ctx.levels.slice(0, 1) }
    case 'rerunLevel': {
      const indices = ctx.levels[action.index]?.indices
      if (!ctx.jobId || !indices) return { request: null, levels: ctx.levels }
      return { request: selectionRequest(ctx.jobId, indices, ctx.controls.dims, ctx.controls.method), levels: ctx.levels }
    }
  }
}

/** Label and Colour are view-only at every level: never a start request (D-21). */
export function onColourChange(
  _state: { level: number },
  prop: string | null
): { start: null; colourProp: string | null } {
  return { start: null, colourProp: prop }
}
