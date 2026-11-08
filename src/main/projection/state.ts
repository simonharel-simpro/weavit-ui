// The one projection slot of a host (D-4): the current dataset, the current run,
// and a placement context per run of that dataset (U-22). Types only.
import type {
  CapReason,
  ProjectionKnownState,
  ProjectionMethod,
  ProjectionReadSource,
  ProjectionScope,
  ProjectionStage,
  PropValue,
  VectorMetric
} from '@shared/types'
import type { Basis, PlacementContext } from './place'
import type { Sidecar } from './sidecar'

export interface Dataset {
  jobId: string
  source: ProjectionReadSource
  metric: VectorMetric
  props: string[]
  uuids: string[]
  /** One column per prop, row order. */
  values: PropValue[][]
  vectors: Float32Array
  dim: number
  n: number
  skipped: { missing: number; dim: number; nonFinite: number; zeroNorm: number }
  matched?: number
  capReason?: CapReason
  complete: boolean
}

export interface Run {
  runId: string
  jobId: string
  kind: 'read' | 'selection'
  /** Root-relative. */
  indices?: Uint32Array
  method: ProjectionMethod
  dims: 2 | 3
  scope: ProjectionScope
  state: ProjectionKnownState
  stage?: ProjectionStage
  progress?: { done: number; total?: number }
  /** Rows streamed so far, then the sidecar's final n. */
  n: number
  frameVersion: number
  /** n×3 */
  pca?: Float32Array
  pca50?: Float32Array
  basis?: Basis
  umap?: { coords: Float32Array; epoch: number; epochs: number; dims: 2 | 3 }
  notice?: string
  error?: string
  sidecar?: Sidecar
  cancelled: boolean
  readComplete: boolean
  rowsStreamed: number
  /** Rows covered by pcaChunks so far. */
  pcaRows: number
  computeProgress?: { stage: ProjectionStage; done: number; total: number }
}

export interface Slot {
  dataset?: Dataset
  run?: Run
  /** runId → context */
  contexts: Map<string, PlacementContext>
  /** Bumped by every start (U-46). */
  generation: number
}

export function createSlot(): Slot {
  return { contexts: new Map(), generation: 0 }
}
