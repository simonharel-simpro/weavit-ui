import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectionStartRequest, ProjectionStartResult, ProjectionStatus } from '@shared/types'
import { api } from '../../lib/api'
import { notifyErr } from '../../lib/notify'
import { queryKeys } from '../../lib/query-keys'
import { useApp } from '../../store'
import { acceptPoints, isKnown, isTerminal, mergeStatus, pointsEnabled, pollInterval, sinceFor } from './frame'

/**
 * React glue only: every decision lives in the pure helpers of frame.ts and breadcrumb.ts.
 * The status polled is the latest run's; `viewRunId` names the level on screen (it differs
 * after Back) and `rootRunId` the root level whose column feeds the inherited colours (U-39).
 */
export function useProjectionRun(viewRunId?: string, rootRunId?: string) {
  const qc = useQueryClient()
  const jobId = useApp((s) => s.projection.jobId)
  const runId = useApp((s) => s.projection.runId)
  const setRun = useApp((s) => s.setProjectionRun)
  // The last frame seen, so a poll asks only for newer ones; a new runId restarts at -1 (U-44).
  const last = useRef<{ runId?: string; version: number }>({ version: -1 })

  const start = useMutation({
    mutationFn: (req: ProjectionStartRequest) => api.projection.start(req),
    onSuccess: ({ jobId: j, runId: r }) => setRun(j, r),
    onError: (e) => notifyErr(e, 'Projection could not start')
  })
  const startRun = (req: ProjectionStartRequest, onStarted?: (r: ProjectionStartResult) => void): void =>
    start.mutate(req, { onSuccess: onStarted })

  const statusKey = queryKeys.projection.status(jobId, runId)
  const status = useQuery({
    queryKey: statusKey,
    queryFn: async (): Promise<ProjectionStatus> => {
      if (!jobId) throw new Error('no projection job')
      const since = sinceFor(last.current.runId, runId, last.current.version)
      const next = await api.projection.status(jobId, { since })
      if (isKnown(next)) last.current = { runId: next.runId, version: next.frameVersion }
      return mergeStatus(qc.getQueryData<ProjectionStatus>(statusKey), next)
    },
    enabled: !!jobId,
    refetchInterval: pollInterval
  })

  const pointsRun = viewRunId ?? runId
  const pointsOf = (target: string | undefined, enabled: boolean) => ({
    queryKey: queryKeys.projection.points(target),
    queryFn: () => {
      if (!jobId) throw new Error('no projection job')
      return api.projection.status(jobId, { points: true, runId: target })
    },
    enabled: enabled && pointsEnabled(status.data),
    staleTime: Infinity,
    gcTime: Infinity, // U-39: a level's points are read once and kept for Back
    select: (s: ProjectionStatus) => acceptPoints(s, target)
  })
  const points = useQuery(pointsOf(pointsRun, true))
  const rootPoints = useQuery(pointsOf(rootRunId, rootRunId !== undefined && rootRunId !== pointsRun))

  const cancel = async (): Promise<void> => {
    if (!jobId) return
    try {
      await api.projection.cancel(jobId)
      await qc.invalidateQueries({ queryKey: statusKey })
    } catch (e) {
      notifyErr(e, 'Cancel failed')
    }
  }

  const isRunning = start.isPending || (!!status.data && !isTerminal(status.data.state))
  return {
    status: status.data,
    statusError: status.error,
    points: points.data,
    rootPoints: rootRunId === pointsRun ? points.data : rootPoints.data,
    start: startRun,
    cancel,
    isRunning
  }
}
