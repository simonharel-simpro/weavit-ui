# Phase 2b — Host session: runs, placement, channels, host wiring

**Depends on:** Phase 2a (`src/shared/projection.ts`, the projection types in `src/shared/types.ts`, `protocol.ts`,
`binary.ts`, `sidecar.ts`, `validate.ts`, `readVectors.ts`) and Phase 1 (the binary). **Agent:** `general-purpose`
(Node main-process TypeScript). **Repo:** worktree `/home/simon/projects/data-science/worktrees/weavit-projector`
(node ≥ 22: `~/.nvm/versions/node/v22.23.1/bin`).

## Goal
The host (Electron main **and** the web-mode `node:http` server — both run `registerHandlers` from
`src/main/ipc/registry.ts`) tracks one projection session: it starts reads and selection runs, turns sidecar events into
run state, answers status/cancel, and places queries in the basis of the run the renderer names. Nothing here renders.

## Contracts used from Phase 2a (restated)
- `startSidecar({path, header, spawnFn}) → Sidecar {write(buf): Promise<void>, end(), kill(), onMessage(cb), onClose(cb:
  (o: {ok:true,n} | {ok:false,error}) => void)}`; messages `progress | basis | pcaChunk | pca50 | notice | frame | done |
  error` (protocol v1, f32 arrays base64 LE, decoded with `decodeF32` from `src/shared/projection.ts`).
- `validateStart(req, {config?, dataset?}) → ValidatedStart` (throws on F-14 rules); `metricOf`; `effectiveCap`.
- `readVectors({source, vector, props, filtered, limit, matched, knownDim, metric, onStart, onPage, isCancelled}) →
  ReadResult {n, dim, uuids, props, vectors, skipped, capReason?}` — first page with vectors → D → cap → `onStart` → `onPage`… (vectorless leading pages are counted, U-41); cosine rows
  arrive already L2-normalised, every other metric (incl. unknown strings) raw (D-19, U-37). `props` = every colourable
  scalar property (text/boolean/int/number, D-21), prefetched so colour and label are view-only.
- Zod schemas from `validate.ts`: `startRequestSchema`, `statusArgsSchema`, `cancelArgsSchema`, `placeQuerySchema`,
  `scopeSchema`; `SidecarMessage = z.infer<typeof messageSchema>` and `Header` / `HEADER_DEFAULTS` from `protocol.ts`.
- `resolveProjectorBinary({appRoot, env, platform, stat}) → {path} | {error}`.
- Constants: `MAX_ROWS` 100 000, `MIN_SELECTION` 16, `NN_DEFAULT` 15, `PAGE_SIZE` 1000, `HEADER_DEFAULTS`.
- Types: `ProjectionStartRequest`, `ProjectionStartResult {jobId, runId}`, `ProjectionStatus` (= `ProjectionStatusKnown |
  {jobId, state:'unknown'}`, the known branch carrying `n` and `readComplete`), `ProjectionScope` (with `props`),
  `ProjectionStatusOptions {since?, points?, runId?}`, `PlaceQueryRequest {jobId, runId, view, query}`, `PlaceQueryResult {placed,
  reason?, coords?, approximate, method?: 'basis'|'knn'|'centroid'|'mean'|'point', inView?, total?}`, `VectorMetric`.

## Session model (one slot, D-4) — types live in `src/main/projection/state.ts`
```ts
export interface Dataset { jobId: string; source: ProjectionReadSource; metric: VectorMetric; props: string[];
  uuids: string[]; values: PropValue[][]; vectors: Float32Array; dim: number; n: number;
  skipped: { missing: number; dim: number; nonFinite: number; zeroNorm: number }; matched?: number;
  capReason?: CapReason; complete: boolean }
export interface Run { runId: string; jobId: string; kind: 'read' | 'selection'; indices?: Uint32Array /* root-relative */;
  method: ProjectionMethod; dims: 2 | 3; scope: ProjectionScope; state: ProjectionKnownState; stage?: ProjectionStage;
  progress?: { done: number; total?: number }; frameVersion: number; pca?: Float32Array /* n×3 */;
  pca50?: Float32Array; basis?: Basis; umap?: { coords: Float32Array; epoch: number; epochs: number; dims: 2 | 3 };
  notice?: string; error?: string; sidecar?: Sidecar; cancelled: boolean; readComplete: boolean; rowsStreamed: number;
  pcaRows: number /* rows covered by pcaChunks so far */;
  computeProgress?: { stage: ProjectionStage; done: number; total: number } }
export interface Slot { dataset?: Dataset; run?: Run; contexts: Map<string, PlacementContext> /* runId → context */;
  generation: number /* bumped by every start (U-46) */ }
export function createSlot(): Slot
```
- A new `start` (any kind) kills the running child (SIGTERM → SIGKILL after 5 s); the old run becomes `superseded`.
- A `read` start replaces the dataset **and clears `contexts`** (drop the old references — F-17). A `selection` start
  keeps both and requires `source.jobId === dataset.jobId && dataset.complete` (F-5; a cancelled read is incomplete, U-30).
- Every event handler (stdout message, close, read-loop page) is bound to its `runId` and is dropped when
  `runId !== slot.run?.runId` (F-5). The read loop's `isCancelled` reads the run's `cancelled` flag between pages.
- **Placement contexts (U-22):** every run of the current dataset that reached `pca50` keeps a `PlacementContext`
  (basis, pca50, PCA frame, latest UMAP frame, uuid → view-index map) under its `runId`, so Back in the renderer's
  breadcrumb can still place queries in that level's frame.
- **Level-local index (U-33):** `toPlacementContext(run, dataset.uuids)` always receives the **root** uuid list and builds
  `uuidIndex` as `uuids[indices[i]] → i` (identity `uuids[i] → i` for a read run). `points.uuids` of a selection is that
  subset in view order and `points.indices` holds the root indices. A uuid outside the selection is absent from the map:
  not highlighted, not counted in view, and an `object` query on it → `{placed:false, reason:'point not in this selection'}`.

## Run transitions (`run.ts`)

| Event | Source | Change |
|---|---|---|
| `start` (read) | host | `state 'reading'`, `stage 'reading'`, `progress {done: 0}`, `n 0`, `readComplete false` |
| `start` (selection) | host | same, except `readComplete true` from the start (its rows come from the complete dataset) and `progress.total = indices.length` |
| `count()` resolves | host | `progress.total = min(matched, cap)` once the cap is known; `undefined` when the count failed (F-1) |
| `onPage(rows, count)` | host | `rowsStreamed += count`; `n = rowsStreamed`; while `reading`: `progress.done = rowsStreamed` |
| read end | host | `sidecar.end()`; `readComplete = !cancelled`; `state 'reading' → 'computing'`; `stage`/`progress` ← `computeProgress` when set, else `stage 'pca'` |
| `hello` | sidecar | none (checked in `sidecar.ts`) |
| `progress{stage,done,total}` | sidecar | `computeProgress` ← it; when `computing`: `stage`, `progress` ← it. While `reading` the visible stage stays `'reading'` (the sidecar already sends `pca` progress and `pcaChunk`s during the read) |
| `basis` | sidecar | `run.basis` |
| `pcaChunk{offset,count}` | sidecar | coords copied into `run.pca` at `offset`; `pcaRows = offset + count`; `frameVersion++` |
| `pca50` | sidecar | `run.pca50`; `contexts.set(runId, toPlacementContext(run, dataset.uuids))` |
| `frame{epoch,epochs}` | sidecar | `run.umap`; `frameVersion++`; context `umap` updated; when `computing`: `stage 'epochs'`, `progress {done: epoch, total: epochs}` |
| `notice` | sidecar | appended to `run.notice` with "; " |
| `done{n}` / `error{message}` | sidecar | recorded only; the terminal state is decided at close |
| child close | sidecar | `{ok:true,n}` → `done`, `n` = it, `progress.done = progress.total`; `{ok:false}` → `failed`, `error`; ignored unless `reading`/`computing` |
| `cancel` | host | `cancelled = true`, kill; `state 'cancelled'`, `stage`/`progress` kept; mid-read → `readComplete` stays false |

`status.n` mid-read = rows streamed to the sidecar so far; after the read, the final n. `status.readComplete` is what the
renderer's `canSelect` reads (U-30), never `stage`.

## Files

#### `src/main/projection/place.ts` (NEW) — pure
```ts
export interface Basis { mean: Float32Array; components: Float32Array /* p×d row-major */; p: number; d: number }
export interface PlacementContext { runId: string; basis: Basis; pca50: Float32Array; p: number; n: number;
  pca: Float32Array /* n×3 */; umap?: { coords: Float32Array; dims: 2 | 3 }; uuidIndex: Map<string, number>;
  indices?: Uint32Array /* root indices of a selection; absent for the root run */ }
export function isApproximate(view: 'pca' | 'umap', kind: ProjectionQuery['kind']): boolean
export function placeExactPca(basis: Basis, q: Float32Array): [number, number, number]  // always 3 (B2, U-53)
export function placeKnn(a: { pca50: Float32Array; p: number; view: Float32Array; dims: 2 | 3; n: number },
  q50: Float32Array, k?: number /* NN_DEFAULT */): number[]
export function placeHits(hits: { uuid: string; distance?: number; score?: number }[], metric: 'distance' | 'score',
  vectorMetric: VectorMetric, uuidIndex: Map<string, number>, view: Float32Array, dims: 2 | 3): PlaceQueryResult
export function placeQuery(ctx: PlacementContext, req: PlaceQueryRequest, vectorMetric: VectorMetric): PlaceQueryResult
```
- **U-21:** `approximate = !(view === 'pca' && kind === 'vector') && kind !== 'object'`. `method`: `'basis'` (vector in
  PCA), `'knn'` (vector in UMAP; the renderer's badge reads "approximate (15-NN)", built from `NN_DEFAULT`), `'centroid'`
  (weighted hits), `'mean'` (the unweighted fallback, U-32), `'point'` (object).
- Vector queries: length ≠ `basis.d` → `{placed:false, reason:'dimension 128, expected 384'}` (F-15); under `cosine`
  the query is L2-normalised first (D-19). PCA view → `placeExactPca`, which always returns the **3** PCA coordinates
  (zero-padded when p < 3) — the PCA view keeps stride 3 for 2D and 3D and the renderer slices for 2D (U-53). UMAP view → project to pca50 with the basis, then
  `placeKnn`: weights 1/d in PCA-p space (Euclidean distances, always ≥ 0); any d = 0 → mean of the zero-distance
  points (U-11); rank-k ties → lower index.
- `placeHits`: in-view hits only (U-12, U-33). Weights (U-10, U-32), ε = 1e-6: `score` → the score; `distance` on a
  cosine collection → `max(ε, 1 − d)`; `distance` on **every other metric** (dot distances can be negative) →
  `w = (d_max − d) + ε` with `d_max` over the in-view hits — sign-safe, rank-preserving, always > 0. Weighted mean →
  `method 'centroid'`. When every weight is ≤ 0 (only possible for scores) → plain mean with `method 'mean'`, so the badge
  never says "hit centroid" for it. None in view → `{placed:false, reason:'no hits in this projection'}` (F-15).
  Returns `inView`, `total`.
- `object` kind → that point's coords from `uuidIndex`, exact; a uuid not in `uuidIndex` → `{placed:false, reason:'point
  not in this selection'}` (U-33). View not ready (no `umap` for a UMAP view) →
  `{placed:false, reason:'view not ready'}`.

#### `src/main/projection/source.ts` (NEW)
`export interface CollectionHandle { query: { fetchObjects(o: Record<string, unknown>): Promise<{ objects: RawObject[] }> };
aggregate: { overAll(o?: Record<string, unknown>): Promise<{ totalCount?: number }> }; filter: unknown }` — `filter` because
`buildFilter` starts from `collection.filter` (`filters.ts:127`); the test fake sets it too — and
`collectionSource(handle, {includeVector, props, filters}): VectorSource & { count(): Promise<number | undefined> }` — the
`fetchObjects` loop of Phase 2a (`after` cursor unfiltered, `offset` + `buildFilter(handle, weaviate.Filters, filters)`
filtered, `filters.ts:252`); `count()` wraps `aggregate.overAll` — with `{filters: buildFilter(…)}` when the read is filtered, exactly as `data.ts:71`
passes `filters: filter` — and returns `undefined` on any error (F-1, U-40).

#### `src/main/projection/state.ts` (NEW) — `Dataset`, `Run`, `Slot` (above) and `createSlot()`; no logic

#### `src/main/projection/run.ts` (NEW) — the transition table above (≤ 200 lines)
```ts
export function createRun(a: { runId: string; jobId: string; kind: 'read' | 'selection'; indices?: Uint32Array;
  method: ProjectionMethod; dims: 2 | 3; scope: ProjectionScope; notice?: string }): Run
export function applyMessage(run: Run, m: SidecarMessage): void   // pcaChunk fills run.pca; basis/pca50/frame stored
export function applyOutcome(run: Run, o: SidecarOutcome): void   // only moves a 'reading'|'computing' run
export function toPlacementContext(run: Run, uuids: string[]): PlacementContext | undefined
export function toStatus(run: Run, ds: Dataset | undefined, o: ProjectionStatusOptions,
  contexts: ReadonlyMap<string, PlacementContext>): ProjectionStatusKnown   // the session passes slot.contexts
```
`frameVersion` increments on every `pcaChunk` and `frame`. `toStatus` includes `pca` / `umap` coords only when
`run.frameVersion > (o.since ?? -1)`; `pca` encodes **only the rows covered so far** (`run.pca.subarray(0, pcaRows * 3)`)
and is absent while `pcaRows` is 0 — the renderer counts points as `coords.length / 3` (U-45). `points` only when
`o.points` (S-8), **for the run named by `o.runId`** (default: the current run; U-39): the root run → every dataset row,
a selection → `dataset.uuids`/columns at that context's `indices`, in view order, `indices` = root indices; `points.runId`
names that run. Resolution: `o.runId` absent or `=== run.runId` → the current run, using `run.indices` (so a run with no
context yet still answers); another runId → `contexts.get(o.runId).indices`; not found → `points` omitted. **U-51:** a
cancelled read keeps the partial dataset `readVectors` resolved (the rows read so far) and serves points for exactly
those rows; a compute-stage failure (`readComplete` true) keeps the dataset and its points; a failed read (`readVectors`
rejected, or the child died mid-read) sets `slot.dataset = undefined` — state `failed`, `readComplete` false, no points. Every metric other than `cosine` and
`l2-squared` — `dot`, `hamming`, `manhattan` or an unknown string (U-37) — seeds `notice: "<metric> metric: Euclidean
layout"`; sidecar notices are appended with "; ".

#### `src/main/projection/session.ts` (NEW) — the slot (≤ 200 lines)
```ts
export interface SessionDeps { appRoot: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  stat?: (p: string) => { isFile: boolean; executable: boolean } | undefined;
  getCollection(connectionId: string, name: string, tenant?: string): Promise<CollectionHandle>;
  getConfig(connectionId: string, name: string): Promise<CollectionConfig>;
  spawnFn?: SpawnFn; now?: () => number; newId?: () => string }
export interface ProjectionSession { start(req: unknown): Promise<ProjectionStartResult>;
  status(jobId: string, o?: ProjectionStatusOptions): ProjectionStatus; cancel(jobId: string): void;
  placeQuery(req: PlaceQueryRequest): PlaceQueryResult; dispose(): void }
export function createProjectionSession(deps: SessionDeps, slot: Slot = createSlot()): ProjectionSession
  // test seam: tests pass their own `slot` and inspect or mutate it (F-16, F-17); `deps.now` drives the watchdog clock
export function createDefaultProjectionSession(appRoot: string): ProjectionSession
  // getCollection = scopeCollection(await getClient(id), name, tenant) (searchOptions.ts:99, connectionManager.ts:115);
  // getConfig = getCollection from collections.ts:180
```
- **`start` resolves `{jobId, runId}` right after validation** (`getConfig` + `validateStart` + binary resolution, all
  before any object read — F-8 rejects here). **Ordering (U-46):** `start` takes its `runId` and `generation =
  ++slot.generation` synchronously, before `await getConfig`; after every `await` it checks `generation ===
  slot.generation`, and a stale start is dropped — it rejects with "superseded by a newer start" and never touches the
  slot. The read and the child run detached; any error lands in the run state
  (`failed`, message as is) and kills the child — never an unhandled rejection.
- **Read order:** `count()` (best effort, F-1) → `readVectors` up to the first page with vectors → D fixed (U-28, U-41) → `effectiveCap` →
  `onStart` spawns with header `{...HEADER_DEFAULTS, nMax: cap, dim: D, method, dims}` → that page written → loop →
  `end()`. A read that returns 0 rows never spawns: state `empty` (F-18). `dataset.complete = true` only when the read
  finished without cancel.
- **Selection start:** same `jobId`, new `runId`; header `nMax = indices.length`, `dim = dataset.dim`; writes the rows of
  `dataset.vectors` at `indices` in `PAGE_SIZE` batches; `scope` = the dataset's read inputs (filters included) with this
  run's `method`/`dims` and `selection = indices.length` (U-24).
- `status(jobId, o)`: unknown jobId → `{jobId, state:'unknown'}`, never throws (F-12); else `toStatus(slot.run, slot.dataset, o, slot.contexts)`.
- `cancel(jobId)`: keep last frame + dataset, state `cancelled`, stage kept (U-15); no-op after a terminal state.
- `placeQuery(req)`: `req.jobId !== dataset.jobId` or no context for `req.runId` → `{placed:false, reason:'run not
  available', approximate:false}` (U-22); else `placeQuery(context, req, dataset.metric)`. Only the query vector is
  projected, never the dataset (F-16). `dispose()` kills the child (F-13).

#### `src/main/ipc/registry.ts` (MODIFY) — `registerHandlers(on: Register, deps: { projection: ProjectionSession })` (`registry.ts:96`)
Register the 4 channels → `deps.projection` methods; `status` never throws (returns `{state:'unknown'}`, F-12).

#### `src/main/ipc/electron.ts` (MODIFY) — `registerIpc(projection: ProjectionSession)` (`electron.ts:4`) passes `{projection}` to `registerHandlers` (`:5`).

#### `src/main/index.ts` (MODIFY)
`const projection = createDefaultProjectionSession(app.getAppPath())` in `whenReady` (`index.ts:79`); `registerIpc(projection)`
(`index.ts:86`); `before-quit` (`index.ts:98`) calls `projection.dispose()` next to `closeAll()`.

#### `src/web/main.ts` (MODIFY)
`const projection = createDefaultProjectionSession(resolve(__dirname, '../../..'))` (the server runs from `out/web/server`,
whose static root is resolved the same way at `main.ts:44`); `registerHandlers(…, { projection })` (`main.ts:40`);
`process.on('SIGINT' | 'SIGTERM', () => { projection.dispose(); process.exit(0) })`.

## Tests (vitest, node env; fakes: `spawnFn` with PassThrough streams, fake `CollectionHandle`, fake config)

Test files: `src/main/projection/place.test.ts`, `run.test.ts`, `session.test.ts`. Session tests build the session with
`createProjectionSession(fakeDeps, slot)` and keep `slot` to inspect it.

| Test | Given → expected | Source |
|---|---|---|
| `run: transitions follow the table` | read start → `reading/reading`; `onPage(1000)` ×2 → `n 2000`, `progress.done 2000`; sidecar `progress{stage:'pca'}` while reading → stage still `reading`; read end → `computing`, stage `pca`, `readComplete true`; `frame{epoch 10, epochs 200}` → stage `epochs`, progress 10/200; close ok → `done` | 2b |
| `session: start resolves before the read completes` | `fetchObjects` pending → `start` resolves `{jobId, runId}`; `status` → state `reading` | 2b |
| `session: spawns after page 1 with nMax = cap and dim = D` | limit 5 000, page 1 of 1 000 rows length 384 → spawn called after fetch #1 and before fetch #2; header `nMax 5000, dim 384` | U-28, U-8 |
| `F-8: should not read when the binary is unresolvable` | resolver error → `start` rejects with the F-8 text; `fetchObjects` never called | F-8 |
| `F-1: should start a run when the aggregate count throws` | `overAll` rejects → run proceeds, `progress.total` undefined | F-1 |
| `F-3: should fail the run, not finish it, when a filtered page throws` | page 4 rejects "query maximum results" → state `failed`, error contains the Weaviate text, child killed, never `done` | F-3 |
| `F-4: should fail the run and keep the host alive when the child closes stdin mid-stream` | child closes stdin after chunk 1 → `failed`, no uncaught exception, no more page reads | F-4 |
| `F-5: should ignore a frame and an exit from a killed run after a new run starts` | A emits frame + exit(1) after B spawned → B unchanged, A `superseded` | F-5 |
| `F-5: should reject a selection whose jobId is not the current dataset` | selection with old jobId → rejected, nothing spawned | F-5 |
| `F-7: should fail the run and kill the child when a page read rejects` | `fetchObjects` rejects → `failed`, kill called | F-7 |
| `F-12: should return a terminal unknown state for an unknown jobId` | `status("nope")` → `{jobId:'nope', state:'unknown'}`, no throw | F-12 |
| `F-13: should kill the running child when the session is disposed` | `dispose()` during computing → kill called | F-13 |
| `F-16: should not project the dataset per query` | after a run, the test sets `slot.dataset.vectors = new Float32Array(0)` → two `placeQuery` calls (UMAP view) still return the same coords as before the swap: placement reads only `pca50` and the query vector | F-16 |
| `F-17: should drop the previous dataset on a new start` | injected `slot`; start read B → `slot.dataset.jobId` = B, `slot.contexts` has no key of run A, no field of `slot` references A's `vectors` | F-17 |
| `F-18: should finish as empty without spawning when the read returns 0 rows` / `U-9: should not spawn the sidecar for an empty read` | 0 rows → state `empty`, n 0, spawn not called | F-18, U-9 |
| `U-15: should keep the last frame after cancel and report the stage` | 2 frames then cancel → `{state:'cancelled', umap.epoch: 20, stage:'epochs'}`; cancel again → unchanged | U-15 |
| `U-30: should reject a selection after a cancelled read` | cancel during `reading` → `dataset.complete` false; selection start → rejected "read was cancelled — Run again to select" | U-30 |
| `U-6/U-24: status echoes the run inputs` | read on A/t1/vec, filters F, umap, dims 3, limit 5 000, config props [title text, year int], D 384 → `scope` deep-equals `{connectionId, collection:'A', tenant:'t1', vector:'vec', filters:F, method:'umap', dims:3, limit:5000, props:['title','year'], dim:384, metric:'cosine'}` and passes `scopeSchema` | U-6, U-24 |
| `D-21: points carry every prefetched column` | read with props [title, year] → `status(id,{points:true}).points.columns` has 2 columns of length n, `year` values are numbers | D-21 |
| `status: n and readComplete mid-read` | 2 pages of 1 000 written, page 3 pending → `n 2000`, `readComplete false`; after the read → `readComplete true` | U-30 |
| `U-24: a selection's scope keeps the root filters` | selection of 20 indices after read with filters F, dims 2 → `scope.filters` = F, `scope.selection` = 20, `scope.dims` = 2 | U-24 |
| `status: coords only when frameVersion > since` | run at `frameVersion` 3 → `status(id,{since:3})` has no `pca`/`umap`; `{since:2}` includes them; `{}` includes them | payload |
| `U-2: should place a query with the requested run's basis after drilling down` | run 1 basis mean 0, run 2 (selection) basis mean 5 → `placeQuery({runId: run2, view:'pca'})` uses mean 5 | U-2 |
| `U-22: should place in level 1's basis after a level-2 selection` | read L1 (mean 0) → selection L2 (mean 5) → `placeQuery({runId: L1, view:'pca', query: q})` = L1 projection of q, ≠ the L2 result | U-22 |
| `U-22: should refuse an unknown runId` | `placeQuery({runId:'gone'})` → `{placed:false, reason:'run not available', approximate:false}` | U-22 |
| `U-39: should answer points for the requested level` | read L1 (N = 2 000) → selection L2 (20 indices) → `status(j,{points:true, runId:L1}).points` has `uuids.length === 2000` and `runId` L1; `{runId:L2}` → 20 uuids, `indices` = the 20 root indices; `{runId:'gone'}` → no `points` | U-39 |
| `U-40: should pass the filters to the count` | filtered read with 500 matches → `overAll` called with `{filters: <built filter>}`; unfiltered → called without filters | U-40 |
| `U-45: should send only the PCA rows covered so far` | fitRows 10 000; 9 000 rows streamed, no `pcaChunk` yet → status has no `pca` field · after `pcaChunk{offset 0, count 10000}` → `decodeF32(pca).length === 30000` | U-45 |
| `U-46: should keep the newer of two racing starts` | start A, start B; B's `getConfig` resolves first, then A's → `slot.run.runId` = B's; A's promise rejects "superseded by a newer start"; `spawnFn` called once | U-46 |
| `U-51: should drop the dataset when the read fails` | page 3 rejects → state `failed`, `readComplete false`, `slot.dataset` undefined, `status(j,{points:true})` has no `points` · child exits 1 after the read ended → `failed`, `readComplete true`, points still served | U-51 |
| `U-39: should answer points for a run that has no context yet` | selection started, no `pca50` yet → `status(j,{points:true, runId: thatRun})` → its subset via `run.indices` | U-39 |
| `U-51: should serve points for a cancelled read` | cancel after 2 pages of 1 000 → state `cancelled`, `readComplete false`; `status(j,{points:true}).points.uuids.length === 2000` | U-51 |
| `U-53: placeExactPca always returns 3 coordinates` | basis p = 2 (n 3) and p = 50 → `placeExactPca` length 3 both times; p = 2 → third coordinate 0 | U-53 |
| `U-21: approximate per view and kind` | `{view:'umap',kind:'vector'}` → true, method `knn` · `{view:'pca',kind:'vector'}` → false, `basis` · object → false, `point` · hits → true, `centroid` | U-21 |
| `U-10: should weight nearText hits by 1-distance and bm25 hits by score` | cosine; hits x=0 (d 0.1), x=10 (d 0.9) → x ≈ 1.0, method `centroid` · scores all 0 → x = 5, method `mean` | U-10, U-32 |
| `U-20: should weight l2 hits rank-safely` | metric `l2-squared`; hits x=0 (d 4), x=10 (d 16) → weights [12 + ε, ε] → x ≈ 0 (±1e-4), method `centroid` | U-20, U-32 |
| `U-32: should give positive, ordered weights to negative dot distances` | metric `dot`; hits x=0 (d −10), x=10 (d −2) → both weights > 0, w₀ > w₁, marker x in (0, 10) on the segment between them | U-32 |
| `U-32: should stay finite near zero` | metric `dot`; hits d = [−1e-7, −5] at x = 0 and x = 10 → coords finite | U-32 |
| `U-33: should index a selection's points locally` | selection indices [10, 20, 30]; hits [root uuid of row 20] → `{placed:true, inView:1, total:1}`, coords = view[1] | U-33 |
| `U-33: should refuse an object outside the selection` | same selection; `{kind:'object', uuid: root uuid of row 5}` → `{placed:false, reason:'point not in this selection'}` | U-33 |
| `U-37: should add the Euclidean-layout notice for manhattan` | config distance `manhattan` → `status.notice` starts "manhattan metric: Euclidean layout"; `l2-squared` → no notice | U-37 |
| `U-20: should normalise a cosine query before placement` | cosine basis; queries [2,0,…] and [1,0,…] → identical coords | U-20 |
| `U-20: should add the Euclidean-layout notice for dot` | config distance `dot` → `status.notice` starts "dot metric: Euclidean layout" | U-20 |
| `U-11: should place a query at the matching point when its distance is 0` | query = row 7 (UMAP view) → coords = view[7] within ε = 1e-4 per coordinate (the TS-projected query is not bit-equal to the Rust `pca50`) | U-11 |
| `U-12: centre on present hits only` | 20 hits, 14 in view → centroid over 14, `{inView:14, total:20}` · 0 in view → placed false | U-12, F-15 |
| `F-15: should reject a query vector whose length differs from the basis` | D 384 basis, 128-d query → `{placed:false, reason:'dimension 128, expected 384'}` | F-15 |

## Constraints
- No `any` without a comment; `import type` for types (advisory: no ESLint config in the fork, review enforces them);
  zod for every channel arg (`start` parses `unknown`).
- `child_process` stays in `sidecar.ts` only (the Phase 2a guard test fails otherwise).
- Never log vectors or label values; log run ids, stages, counts, the stderr tail.
- `session.ts` and `run.ts` ≤ 200 lines each; follow `src/main/weaviate/*.ts` style, tests next to code.

## Done when
`pnpm typecheck`, `pnpm test:coverage` (≥ 70 % on the projection files) and `pnpm build` pass; a manual run against the
local data-lab Weaviate (`127.0.0.1:8090`) through the web host returns frames for the MiniRag collection.

<!-- plan-validate: READY 2026-11-07 sha256:23a3859cd95d -->
