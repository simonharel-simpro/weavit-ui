// The projector's Weaviate read: a VectorSource over one scoped collection, plus
// a best-effort count (F-1). Cursor paging unfiltered, offset + filter filtered.
import { Filters } from 'weaviate-client'
import type { FilterNode } from '@shared/types'
import { buildFilter } from '../weaviate/filters'
import type { RawObject, VectorSource } from './readVectors'

export interface CollectionHandle {
  query: { fetchObjects(o: Record<string, unknown>): Promise<{ objects: RawObject[] }> }
  aggregate: { overAll(o?: Record<string, unknown>): Promise<{ totalCount?: number }> }
  /** buildFilter starts from `collection.filter` (filters.ts). */
  filter: unknown
}

export function collectionSource(
  handle: CollectionHandle,
  o: { includeVector: true | string[]; props: string[]; filters?: FilterNode[] }
): VectorSource & { filtered: boolean; count(): Promise<number | undefined> } {
  const filter: unknown = buildFilter(handle, Filters, o.filters)
  const filtered = filter !== undefined
  return {
    filtered,
    async fetchPage({ after, offset, limit }) {
      const opts: Record<string, unknown> = { limit, includeVector: o.includeVector }
      // An empty list is not "no properties" for every client version: omit it instead.
      if (o.props.length > 0) opts.returnProperties = o.props
      if (filtered) Object.assign(opts, { filters: filter, offset: offset ?? 0 })
      else if (after !== undefined) opts.after = after
      const res = await handle.query.fetchObjects(opts)
      return (res.objects ?? []).map((x) => ({ uuid: x.uuid, properties: x.properties ?? {}, vectors: x.vectors }))
    },
    async count() {
      try {
        const agg = await handle.aggregate.overAll(filtered ? { filters: filter } : undefined)
        return typeof agg?.totalCount === 'number' ? agg.totalCount : undefined
      } catch {
        return undefined
      }
    }
  }
}
