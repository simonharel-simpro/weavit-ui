// Runs one projection run against the slot: streams a Weaviate read (or a
// selection's rows) into the sidecar and routes its events into run state.
// Every handler is bound to its run and dropped once a newer start replaced it (F-5).
import { PAGE_SIZE } from '@shared/projection'
import { errorMessage } from '../util'
import { f32Bytes, HEADER_DEFAULTS, type SidecarMessage } from './protocol'
import { readVectors, type VectorSource } from './readVectors'
import * as R from './run'
import { startSidecar, type SpawnFn } from './sidecar'
import { collectionSource, type CollectionHandle } from './source'
import type { Dataset, Run, Slot } from './state'
import type { ValidatedStart } from './validate'

export type ReadStart = Extract<ValidatedStart, { kind: 'read' }>
export interface Driver {
  /** Runs the job detached: any error lands in the run state, never as an unhandled rejection. */
  launch(run: Run, job: Promise<void>): void
  read(run: Run, v: ReadStart, path: string): Promise<void>
  select(run: Run, ds: Dataset, path: string): Promise<void>
}

export function createDriver(
  slot: Slot,
  deps: {
    getCollection(connectionId: string, name: string, tenant?: string): Promise<CollectionHandle>
    spawnFn?: SpawnFn
    now: () => number
  }
): Driver {
  const startedAt = new WeakMap<Run, number>()
  const current = (run: Run): boolean => slot.run === run
  const active = (run: Run): boolean => run.state === 'reading' || run.state === 'computing'

  function report(run: Run): void {
    const ms = deps.now() - (startedAt.get(run) ?? deps.now())
    const why = run.error ? `: ${run.error}` : ''
    console.info(`[projection] run ${run.runId} ${run.state} at ${run.stage ?? '-'}, n ${run.n}, ${ms} ms${why}`)
  }

  function fail(run: Run, e: unknown): void {
    if (!current(run) || !active(run)) return
    run.state = 'failed'
    run.error = errorMessage(e)
    run.sidecar?.kill(run.error)
    report(run)
  }

  function onMessage(run: Run, m: SidecarMessage): void {
    if (!current(run)) return
    R.applyMessage(run, m)
    if (m.type === 'pca50' && slot.dataset) {
      const ctx = R.toPlacementContext(run, slot.dataset.uuids)
      if (ctx) slot.contexts.set(run.runId, ctx)
    }
    const ctx = slot.contexts.get(run.runId)
    if (m.type === 'frame' && ctx && run.umap) ctx.umap = { coords: run.umap.coords, dims: run.umap.dims }
  }

  function spawn(run: Run, path: string, nMax: number, dim: number): void {
    const header = { ...HEADER_DEFAULTS, nMax, dim, method: run.method, dims: run.dims }
    const sc = startSidecar({ path, header, spawnFn: deps.spawnFn })
    run.sidecar = sc
    sc.onMessage((m) => onMessage(run, m))
    sc.onClose((o) => {
      if (!active(run)) return // a superseded or cancelled run keeps its state
      R.applyOutcome(run, o)
      report(run)
    })
  }

  async function write(run: Run, rows: Float32Array, count: number): Promise<void> {
    if (!run.sidecar) return // onStart skipped the spawn after a cancel
    try {
      await run.sidecar.write(f32Bytes(rows))
    } catch (e) {
      if (run.cancelled) return // the kill of a cancel breaks stdin; that is not a failure
      throw e
    }
    R.applyPage(run, count)
  }

  /** Pages that land after a cancel are dropped, so the partial dataset is what was streamed (U-51). */
  const untilCancelled = (run: Run, src: VectorSource): VectorSource => ({
    fetchPage: (o) =>
      src.fetchPage(o).then(
        (page) => (run.cancelled ? [] : page),
        (e: unknown) => {
          if (run.cancelled) return []
          throw e
        }
      )
  })

  return {
    launch(run, job) {
      startedAt.set(run, deps.now())
      job.catch((e: unknown) => fail(run, e))
    },

    async read(run, v, path) {
      const { source, props, metric } = v
      const handle = await deps.getCollection(source.connectionId, source.collection, source.tenant)
      const src = collectionSource(handle, { includeVector: v.includeVector, props, filters: source.filters })
      const matched = await src.count() // best effort (F-1)
      const r = await readVectors({
        ...{ source: untilCancelled(run, src), vector: source.vector, props, metric, matched },
        filtered: src.filtered,
        limit: source.limit,
        isCancelled: () => run.cancelled,
        onStart: async ({ dim, cap }) => {
          if (!current(run) || run.cancelled) return
          run.scope.dim = dim
          if (run.progress) run.progress.total = matched === undefined ? undefined : Math.min(matched, cap)
          spawn(run, path, cap, dim)
        },
        onPage: (rows, count) => write(run, rows, count)
      })
      // U-51: a failed read (page error, or the child died mid-read) never sets the dataset; start cleared it.
      if (!current(run) || run.state === 'failed') return
      const { uuids, vectors, dim, n, skipped, capReason } = r
      const complete = !run.cancelled
      slot.dataset = { jobId: run.jobId, source, metric, props, uuids, values: r.props, vectors, dim, n, skipped, matched, capReason, complete }
      if (n > 0 || !complete) return R.endRead(run)
      Object.assign(run, { state: 'empty', stage: undefined, readComplete: true }) // F-18: never spawned
      report(run)
    },

    async select(run, ds, path) {
      const indices = run.indices ?? new Uint32Array(0)
      const d = ds.dim
      spawn(run, path, indices.length, d)
      for (let at = 0; at < indices.length && !run.cancelled; at += PAGE_SIZE) {
        const batch = indices.subarray(at, at + PAGE_SIZE)
        const rows = new Float32Array(batch.length * d)
        batch.forEach((i, k) => rows.set(ds.vectors.subarray(i * d, (i + 1) * d), k * d))
        await write(run, rows, batch.length)
      }
      if (current(run)) R.endRead(run)
    }
  }
}
