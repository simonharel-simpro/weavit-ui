import { MAX_ROWS } from '@shared/projection'
import type {
  CollectionConfig,
  FilterNode,
  ProjectionMethod,
  ProjectionScope,
  ProjectionStartRequest,
  PropertyConfig,
  ProjectionStatusKnown
} from '@shared/types'

type Points = NonNullable<ProjectionStatusKnown['points']>

export interface Controls {
  vector?: string
  limit: number
  filters: FilterNode[]
  method: ProjectionMethod
  dims: 2 | 3
}

export function defaultControls(config: Pick<CollectionConfig, 'namedVectors'>): Controls {
  const vector = config.namedVectors.find((v) => v.multiVector !== true)?.name
  return { vector, limit: MAX_ROWS, filters: [], method: 'umap', dims: 2 }
}

export function canRun(controls: Controls): { ok: true } | { ok: false; hint: string } {
  return controls.vector === undefined ? { ok: false, hint: 'no single-vector space (#32)' } : { ok: true }
}

/** The scalar type, or undefined for an array property (never offered, never fetched). */
export function scalarType(p: PropertyConfig): string | undefined {
  const t = p.dataType[0]
  return t !== undefined && !t.endsWith('[]') ? t : undefined
}

export function defaultRoles(properties: PropertyConfig[]): { labelProp?: string; colourProp?: string } {
  const typed = properties.map((p) => ({ name: p.name, type: scalarType(p) }))
  const labelProp = typed.find((p) => p.type === 'text')?.name
  const colourProp = typed.find(
    (p) => p.name !== labelProp && (p.type === 'text' || p.type === 'boolean')
  )?.name
  return {
    ...(labelProp !== undefined && { labelProp }),
    ...(colourProp !== undefined && { colourProp })
  }
}

export function controlsFromScope(scope: ProjectionScope): Controls {
  return {
    vector: scope.vector,
    limit: scope.limit,
    filters: scope.filters ?? [],
    method: scope.method,
    dims: scope.dims
  }
}

/** Label and Colour are view-only and never compared (D-21). */
export function isEdited(controls: Controls, scope: ProjectionScope): boolean {
  const run = controlsFromScope(scope)
  return (
    controls.vector !== run.vector ||
    controls.limit !== run.limit ||
    controls.method !== run.method ||
    controls.dims !== run.dims ||
    JSON.stringify(controls.filters) !== JSON.stringify(run.filters)
  )
}

export function roleColumn(points: Points, prop: string | undefined): Points['columns'][number] | undefined {
  if (prop === undefined) return undefined
  const i = points.props.indexOf(prop)
  return i < 0 ? undefined : points.columns[i]
}

/**
 * `chosen`: a prop, `null` (explicitly cleared) or `undefined` (never touched → the default).
 * A prop the run did not prefetch is ignored.
 */
export function resolveRole(
  chosen: string | null | undefined,
  fallback: string | undefined,
  props: string[]
): string | undefined {
  if (chosen === null) return undefined
  const pick = chosen !== undefined && props.includes(chosen) ? chosen : fallback
  return pick !== undefined && props.includes(pick) ? pick : undefined
}

/** The `read` start request for the controls; a vector must be chosen (see `canRun`). */
export function startRequest(
  view: { connectionId: string; collection: string; tenant?: string },
  controls: Controls
): ProjectionStartRequest {
  if (controls.vector === undefined) throw new Error('startRequest needs a vector')
  return {
    source: {
      kind: 'read',
      ...view,
      vector: controls.vector,
      filters: controls.filters.length > 0 ? controls.filters : undefined,
      limit: controls.limit
    },
    method: controls.method,
    dims: controls.dims
  }
}
