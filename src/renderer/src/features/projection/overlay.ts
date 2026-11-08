import { NN_DEFAULT, OVERLAY_K } from '@shared/projection'
import type {
  PlaceQueryResult,
  ProjectionQuery,
  ProjectionScope,
  SearchRequest,
  SearchResult,
  WeaviateObject
} from '@shared/types'

export interface OverlayInput {
  mode: 'nearText' | 'bm25' | 'hybrid' | 'vector' | 'point'
  text?: string
  vector?: number[]
  uuid?: string
}

export function clampK(k?: number): number {
  if (k === undefined || !Number.isFinite(k)) return OVERLAY_K.default
  return Math.min(OVERLAY_K.max, Math.max(OVERLAY_K.min, Math.round(k)))
}

/** Always inside the run's tenant, vector space and filter: the UI has no override (U-5). */
export function overlaySearchRequest(scope: ProjectionScope, input: OverlayInput, k?: number): SearchRequest {
  const limit = clampK(k)
  const base = {
    connectionId: scope.connectionId,
    collection: scope.collection,
    ...(scope.tenant !== undefined && { tenant: scope.tenant }),
    filters: scope.filters ?? [],
    includeVector: false,
    // The implicit unnamed space has no target vector name (searchOptions passes it through).
    ...(input.mode !== 'bm25' && scope.vector !== 'default' && { targetVector: scope.vector })
  }
  switch (input.mode) {
    case 'nearText':
    case 'bm25':
    case 'hybrid': {
      if (!input.text?.trim()) throw new Error('the query needs text')
      return { ...base, type: input.mode, queryText: input.text, limit }
    }
    case 'vector': {
      if (!input.vector) throw new Error('the query needs a vector')
      return { ...base, type: 'nearVector', queryVector: JSON.stringify(input.vector), limit }
    }
    case 'point': {
      if (!input.uuid) throw new Error('the query needs a point')
      // One more than k: the source object is its own nearest hit and is dropped (U-13).
      return { ...base, type: 'nearObject', queryObjectId: input.uuid, limit: limit + 1 }
    }
  }
}

function numberOf(o: WeaviateObject, key: 'distance' | 'score'): number | undefined {
  const v = o.metadata?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** The hit uuids to highlight: the source point of a nearObject search is not its own hit. */
export function hitUuidsOf(results: SearchResult, mode: OverlayInput['mode'], sourceUuid?: string): string[] {
  const all = results.objects.map((o) => o.uuid)
  return mode === 'point' ? all.filter((u) => u !== sourceUuid) : all
}

/** What the host places the marker from (U-10, U-13). `vector` is the query vector of a `vector` search. */
export function hitsForPlacement(
  results: SearchResult,
  mode: OverlayInput['mode'],
  sourceUuid?: string,
  vector?: number[]
): ProjectionQuery {
  if (mode === 'point') {
    if (!sourceUuid) throw new Error('a point query needs its source uuid')
    return { kind: 'object', uuid: sourceUuid }
  }
  if (mode === 'vector') {
    if (!vector) throw new Error('a vector query needs its vector')
    return { kind: 'vector', vector }
  }
  const metric = mode === 'nearText' ? 'distance' : 'score'
  const hits = results.objects.map((o) => {
    const value = numberOf(o, metric)
    return value === undefined ? { uuid: o.uuid } : { uuid: o.uuid, [metric]: value }
  })
  return { kind: 'hits', metric, hits }
}

export function uuidIndexOf(uuids: string[]): Map<string, number> {
  return new Map(uuids.map((u, i) => [u, i]))
}

/** `uuidIndex` is the level on screen's, so a selection highlights its local indices only (U-33). */
export function highlightSet(
  hitUuids: string[],
  uuidIndex: Map<string, number>
): { indices: Set<number>; inView: number; total: number } {
  const indices = new Set<number>()
  for (const u of hitUuids) {
    const i = uuidIndex.get(u)
    if (i !== undefined) indices.add(i)
  }
  return { indices, inView: indices.size, total: hitUuids.length }
}

/** The canvas highlight: the overlay's hits plus the point opened in the drawer. */
export function mergeHighlight(hits: Set<number> | undefined, selected: number | undefined): Set<number> | undefined {
  if (selected === undefined || selected < 0) return hits
  return new Set([...(hits ?? []), selected])
}

export function approximateBadge(r: PlaceQueryResult): string | null {
  switch (r.method) {
    case 'knn':
      return `approximate (${NN_DEFAULT}-NN)`
    case 'centroid':
      return 'approximate (hit centroid)'
    case 'mean':
      return 'approximate (unweighted mean of hits)'
    default:
      return null
  }
}

/** The react-query key of the placement call (U-23); the caller appends what identifies the query. */
export function placementKey(
  level: { runId: string },
  view: 'pca' | 'umap',
  dims: 2 | 3,
  epoch?: number
): unknown[] {
  return ['placeQuery', level.runId, view, dims, epoch]
}

export type VectorParse = { ok: true; vector: number[] } | { ok: false; error: string }

/** The pasted vector must be a non-empty number array of the run's dimension (F-15). */
export function parseVector(text: string, dim: number): VectorParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not a number array' }
  }
  const isNumbers = Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'number' && Number.isFinite(x))
  if (!isNumbers) return { ok: false, error: 'not a number array' }
  const vector = parsed as number[]
  return vector.length === dim ? { ok: true, vector } : { ok: false, error: `dimension ${vector.length}, expected ${dim}` }
}
