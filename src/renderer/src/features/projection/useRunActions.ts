import { useState } from 'react'
import type { ProjectionScope, ProjectionStartRequest, ProjectionStartResult } from '@shared/types'
import { useApp, type BreadcrumbLevel } from '../../store'
import { resolveRun, runAction, selectionRequest, type RunAction } from './breadcrumb'
import type { Controls } from './defaults'

interface Args {
  view: { connectionId: string; collection: string; tenant?: string }
  controls: Controls
  /** The run's scope; absent before the first run or when the run is another collection's. */
  scope?: ProjectionScope
  levels: BreadcrumbLevel[]
  start(req: ProjectionStartRequest, onStarted: (r: ProjectionStartResult) => void): void
  cancel(): Promise<void>
}

/** Executes what breadcrumb.ts decides: the Run button, the lasso's selection run and Back. */
export function useRunActions({ view, controls, scope, levels, start, cancel }: Args) {
  const app = useApp.getState
  // The number of levels a root re-run would clear, while the confirmation is open.
  const [confirmLevels, setConfirmLevels] = useState<number>()

  const execute = (action: RunAction, confirmed?: boolean): void => {
    const decision = resolveRun(action, confirmed, { jobId: app().projection.jobId, levels, controls, view })
    if (!decision.request) return
    if (decision.levels !== levels) app().setProjectionBreadcrumb(decision.levels)
    app().setProjectionView(controls.method)
    start(decision.request, (r) => {
      if (action.kind === 'rerunLevel') app().rerunBreadcrumb(action.index, r.runId, controls.dims)
      else app().setProjectionBreadcrumb([{ jobId: r.jobId, runId: r.runId, label: 'All', dims: controls.dims, status: 'running' }])
    })
  }
  const handleRun = (): void => {
    const action: RunAction = scope ? runAction(levels, levels.length - 1, controls, scope) : { kind: 'root' }
    if (action.kind === 'confirmRoot') setConfirmLevels(action.levels)
    else execute(action)
  }
  const handleConfirm = (accepted: boolean): void => {
    const n = confirmLevels
    setConfirmLevels(undefined)
    if (n !== undefined) execute({ kind: 'confirmRoot', levels: n }, accepted)
  }
  const handleSelect = (rootIndices: number[]): void => {
    const jobId = app().projection.jobId
    if (!jobId) return
    app().setProjectionView('umap')
    start(selectionRequest(jobId, rootIndices, controls.dims), (r) =>
      app().pushBreadcrumb({
        jobId: r.jobId,
        runId: r.runId,
        label: `Selection ${levels.length}`,
        indices: rootIndices,
        dims: controls.dims,
        status: 'running'
      })
    )
  }
  const handleBack = (steps: number): void => {
    if (app().backBreadcrumb(steps) !== undefined) void cancel()
  }
  return { confirmLevels, handleRun, handleConfirm, handleSelect, handleBack }
}
