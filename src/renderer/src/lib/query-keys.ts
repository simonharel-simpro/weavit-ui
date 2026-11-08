// Query keys used by the projection tab. Older features still write the same literals inline;
// ['collection', ...] is shared with DataBrowser and CollectionView, so its shape must not change.
export const queryKeys = {
  collection: (connectionId: string, collection: string) =>
    ['collection', connectionId, collection] as const,
  projection: {
    status: (jobId: string | undefined, runId: string | undefined) =>
      ['projection', jobId, runId] as const,
    points: (runId: string | undefined) => ['projection', runId, 'points'] as const,
    /** `base` is `placementKey(...)`; `stamp` identifies the search whose query is placed. */
    placement: (base: readonly unknown[], stamp: number | undefined) => [...base, stamp] as const
  },
  object: (connectionId: string, collection: string, uuid: string | undefined, tenant?: string) =>
    ['object', connectionId, collection, uuid, tenant] as const
} as const
