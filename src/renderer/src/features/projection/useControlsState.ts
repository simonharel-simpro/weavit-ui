import { useState } from 'react'
import type { CollectionConfig, ProjectionScope } from '@shared/types'
import { useApp } from '../../store'
import { controlsFromScope, defaultControls, type Controls } from './defaults'

const NO_CONTROLS: Controls = { limit: 100_000, filters: [], method: 'umap', dims: 2 }

/** The run inputs: a matching run restores them after a tab switch; edits overlay them until the next Run. */
export function useControlsState(config: CollectionConfig | undefined, scope: ProjectionScope | undefined) {
  const [edits, setEdits] = useState<Partial<Controls>>({})
  const base = scope ? controlsFromScope(scope) : config ? defaultControls(config) : NO_CONTROLS
  const controls: Controls = { ...base, ...edits }
  const handleChange = (patch: Partial<Controls>): void => {
    setEdits((e) => ({ ...e, ...patch }))
    if (patch.dims) useApp.getState().setProjectionDims(patch.dims)
  }
  return { controls, handleChange }
}
