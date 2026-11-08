import { useRef } from 'react'
import type { Viewport } from '@deck.gl/core'
import { Stack } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { useApp } from '../../store'
import { framesToDraw, onColourChange, shouldDraw } from './breadcrumb'
import { ClearBreadcrumbModal } from './ClearBreadcrumbModal'
import { isEdited } from './defaults'
import { cameraKey } from './camera'
import { isKnown, isStale, isTerminal, matchesView } from './frame'
import { canSelectLevel } from './lasso'
import { ProjectionControls } from './ProjectionControls'
import { ProjectionObjectDrawer } from './ProjectionObjectDrawer'
import { ProjectionOverlays } from './ProjectionOverlays'
import { ProjectionStage } from './ProjectionStage'
import { ProjectionToolbar } from './ProjectionToolbar'
import { useBreadcrumbSync } from './useBreadcrumbSync'
import { useControlsState } from './useControlsState'
import { useOverlay } from './useOverlay'
import { usePointDrawer } from './usePointDrawer'
import { useProjectionRun } from './useProjectionRun'
import { useProjectionView } from './useProjectionView'
import { useRunActions } from './useRunActions'

interface Props {
  connectionId: string
  collection: string
  tenant?: string
}

export function ProjectionPanel({ connectionId, collection, tenant }: Props) {
  const slice = useApp((s) => s.projection)
  const app = useApp.getState
  const viewport = useRef<Viewport>()
  const view = { connectionId, collection, tenant }

  const config = useQuery({ queryKey: queryKeys.collection(connectionId, collection), queryFn: () => api.schema.getCollection(connectionId, collection) })
  const levels = slice.breadcrumb
  const level = levels[levels.length - 1]
  const run = useProjectionRun(level?.runId, levels[0]?.runId)
  const known = isKnown(run.status) ? run.status : undefined
  const matches = !known || matchesView(known.scope, view)
  const scope = known && matches ? known.scope : undefined
  useBreadcrumbSync(known, matches)
  const { controls, handleChange } = useControlsState(config.data, scope)

  const drawer = usePointDrawer({ ...view, runId: slice.runId, uuids: run.points?.uuids })
  const v = useProjectionView({
    frames: matches ? framesToDraw(run.status, level) : {},
    props: known?.scope.props ?? [],
    points: run.points,
    rootPoints: levels.length > 1 ? run.rootPoints : undefined,
    config: config.data,
    view: slice.view,
    dims: controls.dims,
    labelProp: slice.labelProp,
    colourProp: slice.colourProp,
    deleted: drawer.deleted
  })
  const actions = useRunActions({ view, controls, scope, levels: matches ? levels : [], start: run.start, cancel: run.cancel })
  const overlay = useOverlay({
    jobId: slice.jobId,
    polledRunId: slice.runId,
    scope,
    level,
    frame: v.frame,
    epoch: matches && shouldDraw(run.status, level) ? known?.umap?.epoch : undefined,
    uuids: run.points?.uuids
  })

  const uuidAt = (i: number): string | undefined => run.points?.uuids[i]
  const queryAction = { label: 'Use as query', onClick: (i: number) => uuidAt(i) && overlay.usePoint(uuidAt(i) as string) }
  // A stored level (Back) is final; the live run settles at a terminal state.
  const settled = !shouldDraw(run.status, level) || isTerminal(known?.state)
  const fitKey = cameraKey({ runId: level?.runId ?? known?.runId ?? '', frame: v.frame, settled })
  const rerun = isStale(known?.umap?.dims, controls.dims, slice.view)

  return (
    <Stack h="100%" gap="xs" p="md" style={{ minHeight: 0 }}>
      <ProjectionControls
        config={config.data}
        controls={controls}
        onChange={handleChange}
        roleOptions={v.roleOptions}
        labelProp={v.labelProp}
        colourProp={v.colourProp}
        onLabel={(p) => app().setProjectionLabel(p)}
        onColour={(p) => app().setProjectionColour(onColourChange({ level: levels.length - 1 }, p).colourProp)}
        isRunning={run.isRunning}
        onRun={actions.handleRun}
        onCancel={() => void run.cancel()}
      />
      <ProjectionToolbar
        status={run.status}
        matches={matches}
        edited={scope ? isEdited(controls, scope) : false}
        rerunDims={rerun ? controls.dims : undefined}
        levels={matches ? levels : []}
        onBack={actions.handleBack}
        view={slice.view}
        onView={(x) => app().setProjectionView(x)}
      />
      <ProjectionStage
        frame={matches ? v.frame : undefined}
        colors={v.colors}
        legend={v.scale.legend}
        legendTitle={v.colourProp ?? ''}
        selectedIndex={drawer.selectedIndex}
        highlight={overlay.highlight?.indices}
        marker={overlay.marker}
        fitKey={fitKey}
        isRunning={run.isRunning}
        onPointClick={(i) => uuidAt(i) && drawer.setUuid(uuidAt(i))}
        onViewportChange={(vp) => (viewport.current = vp)}
        tooltipActions={[queryAction]}
        tooltipLines={v.tooltipLines}
      >
        {v.frame && (
          <ProjectionOverlays
            overlay={overlay}
            vectorDim={scope?.dim ?? 0}
            dims={v.frame.dims}
            coords={v.frame.coords}
            n={v.frame.n}
            getViewport={() => viewport.current}
            levelIndices={run.points?.indices}
            can={canSelectLevel(run.status, level)}
            onSelect={actions.handleSelect}
          />
        )}
      </ProjectionStage>
      {drawer.uuid && (
        <ProjectionObjectDrawer
          {...view}
          uuid={drawer.uuid}
          onClose={() => drawer.setUuid(undefined)}
          onChanged={() => void drawer.handleChanged(v.frame)}
        />
      )}
      <ClearBreadcrumbModal
        levels={actions.confirmLevels}
        onCancel={() => actions.handleConfirm(false)}
        onConfirm={() => actions.handleConfirm(true)}
      />
    </Stack>
  )
}
