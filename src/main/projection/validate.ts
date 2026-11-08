// Start-request validation and the zod schemas for every projection channel
// argument (F-14). Pure: the session supplies the collection config / dataset.
import { z } from 'zod'
import { FILTERED_MAX, MAX_CELLS, MAX_ROWS, MIN_SELECTION } from '@shared/projection'
import type {
  CapReason,
  CollectionConfig,
  FilterNode,
  NamedVectorConfig,
  PlaceQueryRequest,
  ProjectionMethod,
  ProjectionReadSource,
  ProjectionScope,
  ProjectionSelectionSource,
  ProjectionStage,
  ProjectionStartRequest,
  VectorMetric
} from '@shared/types'

export type ValidatedStart =
  | {
      kind: 'read'
      source: ProjectionReadSource
      method: ProjectionMethod
      dims: 2 | 3
      metric: VectorMetric
      includeVector: true | string[]
      /** Every colourable property, config order. */
      props: string[]
    }
  | { kind: 'selection'; source: ProjectionSelectionSource; method: ProjectionMethod; dims: 2 | 3 }

export const stageSchema = z.enum(['reading', 'pca', 'knn', 'graph', 'epochs']) satisfies z.ZodType<ProjectionStage>
export const capReasonSchema = z.enum(['limit', 'dimension', 'offsetLimit']) satisfies z.ZodType<CapReason>

const methodSchema = z.enum(['pca', 'umap'])
const dimsSchema = z.union([z.literal(2), z.literal(3)])
// Shallow on purpose: buildFilter (filters.ts) validates the tree itself (U-42).
const filtersSchema = z
  .array(z.custom<FilterNode>((v) => typeof v === 'object' && v !== null, 'filter must be an object'))
  .optional()
const limitSchema = z.number().int().min(1).max(MAX_ROWS)

export const startRequestSchema = z
  .object({
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('read'),
          connectionId: z.string().min(1),
          collection: z.string().min(1),
          tenant: z.string().min(1).optional(),
          vector: z.string().min(1),
          filters: filtersSchema,
          limit: limitSchema
        })
        .strict(),
      z
        .object({ kind: z.literal('selection'), jobId: z.string().min(1), indices: z.array(z.number().int()) })
        .strict()
    ]),
    method: methodSchema,
    dims: dimsSchema
  })
  .strict() satisfies z.ZodType<ProjectionStartRequest>

export const scopeSchema = z
  .object({
    connectionId: z.string(),
    collection: z.string(),
    tenant: z.string().optional(),
    vector: z.string(),
    filters: filtersSchema,
    method: methodSchema,
    dims: dimsSchema,
    limit: z.number().int(),
    props: z.array(z.string()),
    dim: z.number().int().min(1),
    metric: z.string(),
    selection: z.number().int().min(0).optional()
  })
  .strict() satisfies z.ZodType<ProjectionScope>

export const statusArgsSchema = z.tuple([
  z.string().min(1),
  z
    .object({
      since: z.number().int().optional(),
      points: z.boolean().optional(),
      runId: z.string().min(1).optional()
    })
    .strict()
    .optional()
])
export const cancelArgsSchema = z.tuple([z.string().min(1)])

const hitSchema = z
  .object({ uuid: z.string().min(1), distance: z.number().optional(), score: z.number().optional() })
  .strict()
export const placeQuerySchema = z
  .object({
    jobId: z.string(),
    runId: z.string(),
    view: z.enum(['pca', 'umap']),
    query: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('vector'), vector: z.array(z.number().finite()).min(1) }).strict(),
      z.object({ kind: z.literal('object'), uuid: z.string().min(1) }).strict(),
      z
        .object({ kind: z.literal('hits'), metric: z.enum(['distance', 'score']), hits: z.array(hitSchema) })
        .strict()
    ])
  })
  .strict() satisfies z.ZodType<PlaceQueryRequest>

/** Weaviate's documented default is cosine; any other server string is kept (U-37). */
export function metricOf(v: NamedVectorConfig): VectorMetric {
  return v.distance ?? 'cosine'
}

const COLOURABLE = new Set(['text', 'boolean', 'int', 'number'])

/** Scalar properties the projector prefetches for colour and labels (D-21). */
export function colourableProps(c: CollectionConfig): string[] {
  return c.properties
    .filter((p) => {
      const t = p.dataType[0]
      return t !== undefined && !t.endsWith('[]') && COLOURABLE.has(t)
    })
    .map((p) => p.name)
}

function parseRequest(req: unknown): ProjectionStartRequest {
  const parsed = startRequestSchema.safeParse(req)
  if (parsed.success) return parsed.data
  const why = parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`)
  throw new Error(`Invalid projection request — ${why.join('; ')}`)
}

function checkIndices(indices: number[], n: number): void {
  if (indices.length < MIN_SELECTION) {
    throw new Error(`A selection needs at least ${MIN_SELECTION} points, got ${indices.length}`)
  }
  const seen = new Set<number>()
  for (const i of indices) {
    if (i < 0 || i >= n) throw new Error(`Selection index ${i} is outside [0, ${n})`)
    if (seen.has(i)) throw new Error(`Selection index ${i} is repeated`)
    seen.add(i)
  }
}

export function validateStart(
  req: unknown,
  ctx: { config?: CollectionConfig; dataset?: { jobId: string; n: number; complete: boolean } }
): ValidatedStart {
  const { source, method, dims } = parseRequest(req)
  if (source.kind === 'selection') {
    const ds = ctx.dataset
    if (!ds || ds.jobId !== source.jobId) throw new Error('The selection refers to a dataset that is no longer current')
    if (!ds.complete) throw new Error('The dataset is still being read; select once the read completes')
    checkIndices(source.indices, ds.n)
    return { kind: 'selection', source, method, dims }
  }
  if (!ctx.config) throw new Error(`No collection config for "${source.collection}"`)
  const space = ctx.config.namedVectors.find((v) => v.name === source.vector)
  if (!space) throw new Error(`Collection "${source.collection}" has no vector "${source.vector}"`)
  if (space.multiVector) throw new Error('multi-vector spaces are not supported')
  // The single implicit space is fetched with includeVector: true (resolveIncludeVector idiom).
  const includeVector = source.vector === 'default' ? true : [source.vector]
  return {
    kind: 'read',
    source,
    method,
    dims,
    metric: metricOf(space),
    includeVector,
    props: colourableProps(ctx.config)
  }
}

/** The rows a read may stream, and why it is bounded (U-8, U-1). */
export function effectiveCap(a: { limit: number; d: number; matched?: number; filtered?: boolean }): {
  cap: number
  reason?: CapReason
} {
  if (!Number.isInteger(a.d) || a.d < 1) throw new Error(`Vector dimension ${a.d} is not a positive integer`)
  const dimCap = Math.floor(MAX_CELLS / a.d)
  const unfiltered = Math.min(a.limit, dimCap)
  const cap = a.filtered ? Math.min(unfiltered, FILTERED_MAX) : unfiltered
  const offsetBinds = a.filtered === true && FILTERED_MAX < unfiltered
  if (offsetBinds && (a.matched === undefined || a.matched > FILTERED_MAX)) return { cap, reason: 'offsetLimit' }
  if (dimCap < a.limit) return { cap, reason: 'dimension' }
  if (a.matched !== undefined && a.matched > cap) return { cap, reason: 'limit' }
  return { cap }
}
