import { useEffect } from 'react'
import type { ProjectionStatusKnown } from '@shared/types'
import { useApp } from '../../store'
import { outcomeOf } from './breadcrumb'

/**
 * Keeps the breadcrumb in step with the polled run: a terminal state settles its level and stores
 * the frames Back will show (U-14, U-22); a run of another collection/tenant clears the drill-down.
 */
export function useBreadcrumbSync(known: ProjectionStatusKnown | undefined, matches: boolean): void {
  const levels = useApp((s) => s.projection.breadcrumb)
  const settle = useApp((s) => s.settleBreadcrumb)
  const setBreadcrumb = useApp((s) => s.setProjectionBreadcrumb)

  useEffect(() => {
    // WHY: the host's status is polled outside React; its terminal state is the only signal that a level ended.
    if (!known) return
    if (!matches) {
      if (levels.length > 0) setBreadcrumb([])
      return
    }
    const level = levels.find((l) => l.runId === known.runId)
    const outcome = outcomeOf(known.state)
    if (!level || level.status !== 'running' || !outcome) return
    settle(known.runId, outcome, {
      ...(known.pca && { pcaFrame: known.pca }),
      ...(known.umap && { umapFrame: known.umap.coords }),
      n: known.n
    })
  }, [known, matches, levels, settle, setBreadcrumb])
}
