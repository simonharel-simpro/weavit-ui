// The host's projection session (D-4): one slot, one running child. Validates and
// orders starts (U-46), answers status, cancel and placement; drive.ts runs the
// read or selection itself.
import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import type {
  CollectionConfig,
  PlaceQueryRequest,
  PlaceQueryResult,
  ProjectionStartResult,
  ProjectionStatus,
  ProjectionStatusOptions,
  VectorMetric
} from '@shared/types'
import { getCollection as getCollectionConfig } from '../weaviate/collections'
import { getClient } from '../weaviate/connectionManager'
import { scopeCollection } from '../weaviate/searchOptions'
import { resolveProjectorBinary, type BinaryStat } from './binary'
import { createDriver } from './drive'
import { placeQuery as place } from './place'
import * as R from './run'
import type { SpawnFn } from './sidecar'
import type { CollectionHandle } from './source'
import { createSlot, type Dataset, type Slot } from './state'
import { startRequestSchema, validateStart, type ValidatedStart } from './validate'

export interface SessionDeps {
  appRoot: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  stat?: BinaryStat
  getCollection(connectionId: string, name: string, tenant?: string): Promise<CollectionHandle>
  getConfig(connectionId: string, name: string): Promise<CollectionConfig>
  spawnFn?: SpawnFn
  now?: () => number
  newId?: () => string
}
export interface ProjectionSession {
  start(req: unknown): Promise<ProjectionStartResult>
  status(jobId: string, o?: ProjectionStatusOptions): ProjectionStatus
  cancel(jobId: string): void
  placeQuery(req: PlaceQueryRequest): PlaceQueryResult
  dispose(): void
}

const SUPERSEDED = 'superseded by a newer start'
const NOT_AVAILABLE: PlaceQueryResult = { placed: false, reason: 'run not available', approximate: false }
/** U-37: the layout is Euclidean; only cosine (rows are normalised) and l2 match it. */
const noticeFor = (m: VectorMetric): string | undefined =>
  m === 'cosine' || m === 'l2-squared' ? undefined : `${m} metric: Euclidean layout`

function fileStat(p: string): ReturnType<BinaryStat> {
  try {
    const isFile = statSync(p).isFile()
    let executable = true
    try {
      accessSync(p, constants.X_OK)
    } catch {
      executable = false
    }
    return { isFile, executable }
  } catch {
    return undefined
  }
}

export function createProjectionSession(deps: SessionDeps, slot: Slot = createSlot()): ProjectionSession {
  const newId = deps.newId ?? randomUUID
  const now = deps.now ?? Date.now

  function binaryPath(): string {
    const env = deps.env ?? process.env
    const r = resolveProjectorBinary({ appRoot: deps.appRoot, env, platform: deps.platform ?? process.platform, stat: deps.stat ?? fileStat })
    if ('error' in r) throw new Error(r.error)
    return r.path
  }

  const driver = createDriver(slot, { getCollection: deps.getCollection, spawnFn: deps.spawnFn, now })

  /** What validateStart sees of the dataset; a read in progress is an incomplete one. */
  function datasetView(jobId: string): { jobId: string; n: number; complete: boolean } | undefined {
    const { dataset: ds, run } = slot
    const cancelledRead = ds ? ds.jobId === jobId && !ds.complete : run?.jobId === jobId && run.kind === 'read' && run.cancelled
    if (cancelledRead) throw new Error('read was cancelled — Run again to select') // U-30
    if (ds) return { jobId: ds.jobId, n: ds.n, complete: ds.complete }
    return run?.kind === 'read' && run.state === 'reading' ? { jobId: run.jobId, n: run.n, complete: false } : undefined
  }

  async function start(req: unknown): Promise<ProjectionStartResult> {
    const runId = newId()
    const generation = ++slot.generation // U-46: taken before any await
    const fresh = (): void => {
      if (generation !== slot.generation) throw new Error(SUPERSEDED)
    }
    const parsed = startRequestSchema.safeParse(req)
    if (!parsed.success) validateStart(req, {}) // throws the request's validation message
    const source = parsed.data?.source
    const path = binaryPath() // F-8: before any object read
    let v: ValidatedStart
    if (source?.kind === 'read') {
      const config = await deps.getConfig(source.connectionId, source.collection)
      fresh()
      v = validateStart(req, { config })
    } else {
      v = validateStart(req, { dataset: datasetView(source?.jobId ?? '') })
    }
    fresh()
    if (slot.run) R.cancelRun(slot.run, 'superseded')
    const { method, dims } = v
    if (v.kind === 'read') {
      slot.dataset = undefined // F-17: drop the old dataset and every context on it
      slot.contexts.clear()
      const { kind: _kind, ...inputs } = v.source
      const scope = { ...inputs, method, dims, props: v.props, dim: 0, metric: v.metric }
      const run = R.createRun({ runId, jobId: newId(), kind: 'read', method, dims, scope, notice: noticeFor(v.metric) })
      slot.run = run
      driver.launch(run, driver.read(run, v, path))
      return { jobId: run.jobId, runId }
    }
    const ds = slot.dataset as Dataset
    const indices = Uint32Array.from(v.source.indices)
    const { kind: _root, ...rootInputs } = ds.source
    const scope = { ...rootInputs, method, dims, props: ds.props, dim: ds.dim, metric: ds.metric, selection: indices.length }
    const run = R.createRun({ runId, jobId: ds.jobId, kind: 'selection', indices, method, dims, scope, notice: noticeFor(ds.metric) })
    slot.run = run
    driver.launch(run, driver.select(run, ds, path))
    return { jobId: run.jobId, runId }
  }

  return {
    start,
    status(jobId, o = {}) {
      const run = slot.run
      if (!run || run.jobId !== jobId) return { jobId, state: 'unknown' } // F-12
      return R.toStatus(run, slot.dataset?.jobId === jobId ? slot.dataset : undefined, o, slot.contexts)
    },
    cancel(jobId) {
      if (slot.run?.jobId === jobId) R.cancelRun(slot.run)
    },
    placeQuery(req) {
      const ds = slot.dataset
      const ctx = slot.contexts.get(req.runId)
      if (!ds || ds.jobId !== req.jobId || !ctx) return NOT_AVAILABLE // U-22
      return place(ctx, req, ds.metric)
    },
    dispose() {
      const run = slot.run
      if (!run) return
      run.cancelled = true
      run.sidecar?.kill('session disposed') // F-13
    }
  }
}

export function createDefaultProjectionSession(appRoot: string): ProjectionSession {
  return createProjectionSession({
    appRoot,
    getCollection: async (id, name, tenant) => scopeCollection(await getClient(id), name, tenant),
    getConfig: (id, name) => getCollectionConfig(id, name)
  })
}
