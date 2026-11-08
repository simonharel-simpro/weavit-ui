import { useMemo, useReducer, useState } from 'react'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import type { PlaceQueryResult, ProjectionQuery, ProjectionScope, SearchRequest } from '@shared/types'
import { api } from '../../lib/api'
import { queryKeys } from '../../lib/query-keys'
import { markerFor } from './frame'
import {
  highlightSet,
  hitsForPlacement,
  hitUuidsOf,
  overlaySearchRequest,
  parseVector,
  placementKey,
  uuidIndexOf,
  type OverlayInput
} from './overlay'

export interface OverlayForm {
  mode: OverlayInput['mode']
  text: string
  vectorText: string
  k: number
  pointUuid?: string
}
const INITIAL: OverlayForm = { mode: 'nearText', text: '', vectorText: '', k: 20 }

export interface OverlayArgs {
  jobId?: string
  /** The latest run: a new run clears the overlay (derived, no effect). */
  polledRunId?: string
  scope?: ProjectionScope
  /** The level on screen. */
  level?: { runId: string }
  frame?: { kind: 'pca' | 'umap'; dims: 2 | 3 }
  /** The UMAP frame epoch, so a new frame re-places the marker (U-23). */
  epoch?: number
  /** `points.uuids` of the level on screen. */
  uuids?: string[]
}
interface Searched {
  forRun?: string
  stamp: number
  hitUuids: string[]
  query: ProjectionQuery
}

/** React glue for the query overlay: search, then place; all decisions are in overlay.ts. */
export function useOverlay(a: OverlayArgs) {
  const [form, patch] = useReducer((f: OverlayForm, p: Partial<OverlayForm>) => ({ ...f, ...p }), INITIAL)
  const [error, setError] = useState<string>()
  const [searched, setSearched] = useState<Searched>()
  const mutation = useMutation({ mutationFn: (req: SearchRequest) => api.query.search(req) })
  const visible = searched && searched.forRun === a.polledRunId ? searched : undefined

  const run = (input: OverlayInput): void => {
    if (!a.scope) return
    try {
      const req = overlaySearchRequest(a.scope, input, form.k)
      setError(undefined)
      mutation.mutate(req, {
        onSuccess: (res) =>
          setSearched((prev) => ({
            forRun: a.polledRunId,
            stamp: (prev?.stamp ?? 0) + 1,
            hitUuids: hitUuidsOf(res, input.mode, input.uuid),
            query: hitsForPlacement(res, input.mode, input.uuid, input.vector)
          })),
        onError: (e) => setError(e instanceof Error ? e.message : String(e))
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const search = (): void => {
    if (form.mode !== 'vector') return run({ mode: form.mode, text: form.text, uuid: form.pointUuid })
    const parsed = parseVector(form.vectorText, a.scope?.dim ?? 0)
    if (!parsed.ok) return setError(parsed.error)
    run({ mode: 'vector', vector: parsed.vector })
  }
  /** "Use as query" on a canvas point: arm the mode and search at once. */
  const usePoint = (uuid: string): void => {
    patch({ mode: 'point', pointUuid: uuid })
    run({ mode: 'point', uuid })
  }
  const clear = (): void => {
    setSearched(undefined)
    setError(undefined)
    patch({ ...INITIAL, mode: form.mode, k: form.k, pointUuid: undefined })
  }

  const place = useQuery({
    queryKey: queryKeys.projection.placement(
      a.level && a.frame
        ? placementKey(a.level, a.frame.kind, a.frame.dims, a.frame.kind === 'umap' ? a.epoch : undefined)
        : [],
      visible?.stamp
    ),
    queryFn: (): Promise<PlaceQueryResult> => {
      if (!a.jobId || !a.level || !a.frame || !visible) throw new Error('nothing to place')
      return api.projection.placeQuery({ jobId: a.jobId, runId: a.level.runId, view: a.frame.kind, query: visible.query })
    },
    enabled: !!(a.jobId && a.level && a.frame && visible),
    placeholderData: keepPreviousData // the marker keeps its place until the next frame's position lands
  })

  const index = useMemo(() => uuidIndexOf(a.uuids ?? []), [a.uuids])
  const highlight = useMemo(() => (visible ? highlightSet(visible.hitUuids, index) : undefined), [visible, index])
  const placed = visible ? place.data : undefined
  const marker = placed?.placed && placed.coords && a.frame ? markerFor(placed.coords, a.frame.kind, a.frame.dims) : undefined
  return {
    form,
    patch,
    search,
    clear,
    usePoint,
    busy: mutation.isPending,
    error: error ?? (visible && place.error ? String(place.error) : undefined),
    searched: visible !== undefined,
    highlight,
    marker,
    placement: placed
  }
}
