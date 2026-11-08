import { useState } from 'react'
import { Box, Center, Group, Loader, SegmentedControl, Stack, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import type { ProjectionMethod } from '@shared/types'
import { api } from '../../lib/api'
import { notifyErr } from '../../lib/notify'
import { queryKeys } from '../../lib/query-keys'
import { useApp } from '../../store'
import { ProjectionCanvas } from './ProjectionCanvas'
import { ProjectionControls } from './ProjectionControls'
import { ProjectionObjectDrawer } from './ProjectionObjectDrawer'
import { ProjectionLegend } from './ProjectionLegend'
import { ProjectionStatusLine } from './ProjectionStatusLine'
import { controlsFromScope, defaultControls, isEdited, startRequest, type Controls } from './defaults'
import { afterDelete, isKnown, isStale, matchesView } from './frame'
import { useProjectionRun } from './useProjectionRun'
import { useProjectionView } from './useProjectionView'

interface Props {
  connectionId: string
  collection: string
  tenant?: string
}

const NO_CONTROLS: Controls = { limit: 100_000, filters: [], method: 'umap', dims: 2 }
const NO_DELETED: ReadonlySet<string> = new Set()

export function ProjectionPanel({ connectionId, collection, tenant }: Props) {
  const slice = useApp((s) => s.projection)
  const app = useApp.getState
  const run = useProjectionRun()
  const [edits, setEdits] = useState<Partial<Controls>>({})
  const [uuid, setUuid] = useState<string>()
  const [deletedIn, setDeletedIn] = useState<{ runId?: string; set: ReadonlySet<string> }>({ set: NO_DELETED })

  const config = useQuery({
    queryKey: queryKeys.collection(connectionId, collection),
    queryFn: () => api.schema.getCollection(connectionId, collection)
  })
  const known = isKnown(run.status) ? run.status : undefined
  const matches = !known || matchesView(known.scope, { connectionId, collection, tenant })
  const scope = known && matches ? known.scope : undefined
  // A matching run restores its inputs after a tab switch; edits overlay them until the next Run.
  const base = scope ? controlsFromScope(scope) : config.data ? defaultControls(config.data) : NO_CONTROLS
  const controls: Controls = { ...base, ...edits }
  const deleted = deletedIn.runId === slice.runId ? deletedIn.set : NO_DELETED

  const v = useProjectionView({
    known: matches ? known : undefined,
    points: run.points,
    config: config.data,
    view: slice.view,
    dims: controls.dims,
    labelProp: slice.labelProp,
    colourProp: slice.colourProp,
    deleted
  })

  const handleChange = (patch: Partial<Controls>): void => {
    setEdits((e) => ({ ...e, ...patch }))
    if (patch.dims) app().setProjectionDims(patch.dims)
  }
  const handleRun = (): void => {
    if (controls.vector === undefined) return
    app().setProjectionView(controls.method)
    run.start(startRequest({ connectionId, collection, tenant }, controls))
  }
  const handlePointClick = (i: number): void => {
    const id = run.points?.uuids[i]
    if (id) setUuid(id)
  }
  // The frame is a snapshot: after the drawer changed the object, a missing object is only marked.
  const handleChanged = async (): Promise<void> => {
    const id = uuid
    setUuid(undefined)
    if (!id || !v.frame) return
    try {
      if ((await api.data.getObject(connectionId, collection, id, tenant)) === null) {
        const next = afterDelete({ coords: v.frame.coords, n: v.frame.n, deleted }, id)
        setDeletedIn({ runId: slice.runId, set: next.deleted })
      }
    } catch (e) {
      notifyErr(e)
    }
  }

  const rerun = isStale(known?.umap?.dims, controls.dims, slice.view)
  const selectedIndex = uuid ? run.points?.uuids.indexOf(uuid) : undefined
  const frame = matches ? v.frame : undefined
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
        onColour={(p) => app().setProjectionColour(p)}
        isRunning={run.isRunning}
        onRun={handleRun}
        onCancel={() => void run.cancel()}
      />
      <Group justify="space-between">
        <ProjectionStatusLine
          status={run.status}
          matches={matches}
          edited={scope ? isEdited(controls, scope) : false}
          rerunDims={rerun ? controls.dims : undefined}
          locale={navigator.language}
        />
        <SegmentedControl
          size="xs"
          data={[{ value: 'pca', label: 'PCA view' }, { value: 'umap', label: 'UMAP view' }]}
          value={slice.view}
          onChange={(x) => app().setProjectionView(x as ProjectionMethod)}
        />
      </Group>
      <Box pos="relative" flex={1} mih={0} bg="dark.8" style={{ borderRadius: 4, overflow: 'hidden' }}>
        {frame ? (
          <>
            <ProjectionCanvas
              coords={frame.coords}
              dims={frame.dims}
              n={frame.n}
              colors={v.colors}
              highlight={selectedIndex !== undefined && selectedIndex >= 0 ? new Set([selectedIndex]) : undefined}
              fitKey={known?.runId ?? ''}
              onPointClick={handlePointClick}
              tooltipLines={v.tooltipLines}
            />
            <ProjectionLegend legend={v.scale.legend} title={v.colourProp ?? ''} />
          </>
        ) : (
          <Center h="100%">
            {run.isRunning ? <Loader size="sm" /> : <Text c="dimmed" size="sm">Pick a vector space and press Run.</Text>}
          </Center>
        )}
      </Box>
      {uuid && (
        <ProjectionObjectDrawer
          connectionId={connectionId}
          collection={collection}
          tenant={tenant}
          uuid={uuid}
          onClose={() => setUuid(undefined)}
          onChanged={() => void handleChanged()}
        />
      )}
    </Stack>
  )
}
