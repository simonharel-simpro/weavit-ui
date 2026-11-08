// Test builders for the pure projection helpers (only *.test.ts import it).
import type { ProjectionScope, ProjectionStatusKnown } from '@shared/types'

export function scopeOf(over: Partial<ProjectionScope> = {}): ProjectionScope {
  return {
    connectionId: 'c1',
    collection: 'A',
    tenant: 't1',
    vector: 'v',
    method: 'umap',
    dims: 2,
    limit: 100_000,
    props: [],
    dim: 3,
    metric: 'cosine',
    ...over
  }
}

export function knownOf(over: Partial<ProjectionStatusKnown> = {}): ProjectionStatusKnown {
  return {
    jobId: 'j1',
    runId: 'r1',
    state: 'computing',
    scope: scopeOf(),
    n: 0,
    readComplete: false,
    frameVersion: 0,
    ...over
  }
}
