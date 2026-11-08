# Phase 2a — Host core: shared contract, protocol, sidecar, vector read, validation

**Depends on:** Phase 1 (binary at `native/projector/target/release/weavit-projector`, protocol v1, fixtures in
`native/projector/fixtures/protocol-v1/`). **Agent:** `general-purpose` (Node main-process TypeScript in an
electron-vite project). **Repo:** worktree `/home/simon/projects/data-science/worktrees/weavit-projector`. Use node ≥ 22
(`~/.nvm/versions/node/v22.23.1/bin`) and `pnpm install` first.

## Goal
The building blocks Phase 2b's session wires together: the shared types and constants (one source for main and
renderer), the NDJSON protocol codec, the binary resolver, the one module that spawns the child, the lean Weaviate
vector reader (with the D-19 metric normalisation), and start-request validation. Nothing here holds session state.

## Protocol v1 (restated from Phase 1 — implement exactly)
- stdout line 1: `{"type":"hello","protocol":1}`; mismatch or anything else → outcome failed: "projector protocol N, host
  expects 1 — rebuild: pnpm projector:build" (F-9).
- stdin: header JSON line `{"protocol":1,"nMax","dim","method":"pca"|"umap","dims":2|3,"pcaDims":50,"nNeighbors":15,
  "minDist":0.1,"epochs":200,"seed":42,"frameEvery":10,"batchRows":1000,"fitRows":10000}` then f32 LE rows; **close
  stdin at the end of the data** (actual n = rows written). The child rejects a bad header with exit 2.
- stdout NDJSON: `progress{stage,done,total}`, `basis{mean,components,pcaDims}`, `pcaChunk{offset,count,coords}` (count×3),
  `pca50{n,pcaDims,coords}`, `notice{message}`, `frame{stage:"umap",epoch,epochs,dims,n,coords}`, `done{n}`,
  `error{message}`. f32 arrays = base64 of little-endian bytes. Child exit: 0 ok · 2 header · 3 broken pipe · 1 other.

## Files

#### `src/shared/projection.ts` (NEW) — the single source of the projection constants; main and renderer import it
```ts
export const MAX_ROWS = 100_000
export const MAX_CELLS = 100_000 * 1024          // n·d bound (D-8)
export const NN_DEFAULT = 15
export const MIN_SELECTION = NN_DEFAULT + 1      // 16
export const FILTERED_MAX = 10_000               // server offset limit (D-10)
export const OVERLAY_K = { min: 1, max: 100, default: 20 } as const
export const LABEL_MAX_CHARS = 200
export const PAGE_SIZE = 1000
export function decodeF32(b64: string): Float32Array // atob → bytes → copy into an aligned Float32Array (LE)
```
Phase 3 `frame.ts` imports `decodeF32` from here; no second decoder exists anywhere.

#### `src/shared/types.ts` (MODIFY) — `NamedVectorConfig` (`types.ts:117`) gains two fields
`multiVector?: boolean` and `distance?: VectorMetric`. Add below it:
```ts
export type KnownMetric = 'cosine' | 'dot' | 'l2-squared' | 'hamming' | 'manhattan'
/** Catch-all branch (U-37): an unknown server string is kept as is, never mapped to cosine. */
export type VectorMetric = KnownMetric | (string & {})
export type ProjectionMethod = 'pca' | 'umap'
export type ProjectionStage = 'reading' | 'pca' | 'knn' | 'graph' | 'epochs'
export type CapReason = 'limit' | 'dimension' | 'offsetLimit'
export type ProjectionKnownState = 'reading'|'computing'|'done'|'failed'|'cancelled'|'superseded'|'empty'
export type PropValue = string | number | boolean | null   // scalar only: array properties are not fetched (D-21)
export interface ProjectionReadSource { kind: 'read'; connectionId: string; collection: string; tenant?: string;
  vector: string; filters?: FilterNode[]; limit: number }   // no colour/label inputs: they are view-only (D-21)
export interface ProjectionSelectionSource { kind: 'selection'; jobId: string; indices: number[] /* root-relative */ }
export interface ProjectionStartRequest { source: ProjectionReadSource | ProjectionSelectionSource;
  method: ProjectionMethod; dims: 2 | 3 }
export interface ProjectionStartResult { jobId: string; runId: string }
/** Echo of the run's inputs (U-6, U-24): the renderer restores its controls from it. */
export interface ProjectionScope { connectionId: string; collection: string; tenant?: string; vector: string;
  filters?: FilterNode[]; method: ProjectionMethod; dims: 2 | 3; limit: number; props: string[] /* prefetched */;
  dim: number; metric: VectorMetric; selection?: number /* size */ }
export interface ProjectionStatusKnown { jobId: string; runId: string; state: ProjectionKnownState;
  stage?: ProjectionStage; progress?: { done: number; total?: number }; scope: ProjectionScope;
  n: number /* rows streamed to the sidecar so far; final n once the read ends */; readComplete: boolean;
  skipped?: { missing: number; dim: number; nonFinite: number; zeroNorm: number };
  cap?: { read: number; matched?: number; reason: CapReason }; notice?: string; error?: string;
  frameVersion: number; pca?: string /* b64 n×3 */; umap?: { coords: string; epoch: number; epochs: number; dims: 2|3 };
  points?: { uuids: string[] /* this run's points in view order; a selection's subset */; props: string[];
    columns: PropValue[][] /* one column per prop, view order */; indices?: number[] /* root indices */;
    runId: string /* the run these points belong to (U-39) */ } }
export type ProjectionStatus = ProjectionStatusKnown | { jobId: string; state: 'unknown' }
export interface ProjectionStatusOptions { since?: number /* frameVersion */; points?: boolean;
  runId?: string /* whose points: the root run or a selection level (U-39) */ }
export type ProjectionQuery = { kind: 'vector'; vector: number[] } | { kind: 'object'; uuid: string }
  | { kind: 'hits'; metric: 'distance'|'score'; hits: { uuid: string; distance?: number; score?: number }[] }
export interface PlaceQueryRequest { jobId: string; runId: string; view: 'pca'|'umap'; query: ProjectionQuery }
export interface PlaceQueryResult { placed: boolean; reason?: string; coords?: number[]; approximate: boolean;
  method?: 'basis' | 'knn' | 'centroid' | 'mean' | 'point'; inView?: number; total?: number }
```
`WeftApi` (`types.ts:987`) gains:
```ts
projection: { start(req: ProjectionStartRequest): Promise<ProjectionStartResult>;
  status(jobId: string, opts?: ProjectionStatusOptions): Promise<ProjectionStatus>;
  cancel(jobId: string): Promise<void>; placeQuery(req: PlaceQueryRequest): Promise<PlaceQueryResult> }
```
#### `src/shared/channels.ts` (MODIFY) — `projection: { start: 'projection:start', status: 'projection:status', cancel: 'projection:cancel', placeQuery: 'projection:placeQuery' }`
#### `src/shared/api.ts` (MODIFY) — in `buildApi` (`api.ts:37`) add the `projection` group via `invoke(CH.projection.*, …)` like the other groups. `src/renderer/src/lib/api.ts` needs no change: it re-exports `window.api` typed `WeftApi`, so the new group flows through the type.

#### `src/main/weaviate/collections.ts` (MODIFY) — `extractNamedVectors` (`collections.ts:54-78`)
Named vectors (`:61`) and the unnamed `default` space (`:74`) both set `multiVector: indexConfig?.multiVector != null`
(weaviate-client `config/types/vectorIndex.d.ts:12`) **or** `indexConfig?.hnsw?.multiVector != null` — a `dynamic`
index nests its HNSW config under `hnsw` (`VectorIndexConfigDynamic`, same file `:36-42`, U-48) — and `distance: indexConfig?.distance` as the server string
(absent → `'cosine'`, Weaviate's documented default, in `metricOf` below; any other string is kept verbatim, U-37).

#### `src/main/projection/protocol.ts` (NEW)
`PROTOCOL = 1`; `class ProtocolError extends Error`; `class LineSplitter { push(chunk: Buffer): string[] }` (accumulates,
yields complete lines, a line over 64 MB → `ProtocolError`); `parseMessage(line: string): SidecarMessage`; `encodeHeader(h:
Header): string`.
```ts
export interface Header { protocol: 1; nMax: number; dim: number; method: ProjectionMethod; dims: 2 | 3;
  pcaDims: number; nNeighbors: number; minDist: number; epochs: number; seed: number; frameEvery: number;
  batchRows: number; fitRows: number }
export const HEADER_DEFAULTS = { protocol: 1, pcaDims: 50, nNeighbors: NN_DEFAULT, minDist: 0.1, epochs: 200, seed: 42,
  frameEvery: 10, batchRows: 1000, fitRows: 10_000 } as const satisfies Partial<Header>   // nNeighbors from NN_DEFAULT
export const messageSchema = z.discriminatedUnion('type', [ … ])
export type SidecarMessage = z.infer<typeof messageSchema>   // derived, so TS and zod cannot drift
```
Zod schemas, one per type, in `messageSchema`:
`hello{protocol: z.number().int()}` · `progress{stage: z.enum(['pca','knn','graph','epochs']), done: int ≥ 0, total: int ≥ 0}` ·
`basis{mean: b64, components: b64, pcaDims: int ≥ 1}` · `pcaChunk{offset: int ≥ 0, count: int ≥ 0, coords: b64}` ·
`pca50{n: int ≥ 0, pcaDims: int ≥ 1, coords: b64}` · `notice{message: string}` · `frame{stage: z.literal('umap'),
epoch, epochs, dims: z.union([z.literal(2), z.literal(3)]), n, coords: b64}` · `done{n: int ≥ 0}` · `error{message}`.
After parsing, decoded lengths are checked (`pcaChunk` count×3, `pca50` n×pcaDims, `frame` n×dims, `basis` p×D);
a mismatch is a `ProtocolError`.

#### `src/main/projection/binary.ts` (NEW) — pure
`resolveProjectorBinary({appRoot, env, platform, stat}: {appRoot: string; env: NodeJS.ProcessEnv; platform:
NodeJS.Platform; stat: (p: string) => {isFile: boolean; executable: boolean} | undefined}): {path: string} | {error: string}` —
`WEAVIT_PROJECTOR_BIN` (absolute, a file, executable) else `<appRoot>/native/projector/target/release/weavit-projector`
+ `.exe` on win32. Error text names the env var, the path tried and `pnpm projector:build` (F-8).

#### `src/main/projection/sidecar.ts` (NEW) — the only `child_process` importer
```ts
export type SpawnFn = typeof import('node:child_process').spawn
export type SidecarOutcome = { ok: true; n: number } | { ok: false; error: string }
export interface Sidecar { write(buf: Uint8Array): Promise<void>; end(): void; kill(reason?: string): void;
  onMessage(cb: (m: SidecarMessage) => void): void; onClose(cb: (o: SidecarOutcome) => void): void }
export function startSidecar(o: { path: string; header: Header; spawnFn?: SpawnFn; watchdogMs?: number /* 60_000 */;
  killGraceMs?: number /* 5_000 */ }): Sidecar
```
`spawn(path, [], {stdio:['pipe','pipe','pipe']})` (array args, no shell). `write` resolves when the chunk is flushed
(on `drain` when `write()` returned false) and rejects on `close`/`exit`/`error` (F-4). Error listeners on child, stdin,
stdout, stderr. stderr ring buffer 8 KB. `kill()`: SIGTERM, SIGKILL after `killGraceMs`. Watchdog: no stdout line for
`watchdogMs` → kill + outcome "no output for 60 s" (F-7). Every successful host `write` also resets the watchdog, so a
slow read (the child waits for rows and is silent before its first fit) never trips it; after `end()` only stdout lines
reset it (U-43). Checks `hello` first (F-9). **On the first `ProtocolError` or
a `hello` mismatch the child is killed at once** (no further lines are parsed) and the outcome records it. The outcome is decided once, at
`close` (F-6): `done` seen + code 0 → `{ok:true,n}`; else the `error` message, or "killed by SIGKILL", or "exited with
code N" + the stderr tail; a `ProtocolError` → "protocol error: …".

#### `src/main/projection/validate.ts` (NEW) — pure
```ts
export type ValidatedStart =
  | { kind: 'read'; source: ProjectionReadSource; method: ProjectionMethod; dims: 2|3; metric: VectorMetric;
      includeVector: true | string[]; props: string[] /* every colourable property, config order */ }
  | { kind: 'selection'; source: ProjectionSelectionSource; method: ProjectionMethod; dims: 2|3 }
export function validateStart(req: unknown, ctx: { config?: CollectionConfig;
  dataset?: { jobId: string; n: number; complete: boolean } }): ValidatedStart  // throws Error with the reason
export function metricOf(v: NamedVectorConfig): VectorMetric   // v.distance ?? 'cosine'; unknown strings kept
export function colourableProps(c: CollectionConfig): string[]  // dataType[0] ∈ text|boolean|int|number, no '[]' suffix
export const stageSchema = z.enum(['reading','pca','knn','graph','epochs']) satisfies z.ZodType<ProjectionStage>
export const capReasonSchema = z.enum(['limit','dimension','offsetLimit']) satisfies z.ZodType<CapReason>
export const startRequestSchema = z.object({ … }) satisfies z.ZodType<ProjectionStartRequest>
export const scopeSchema = z.object({ … }).strict() satisfies z.ZodType<ProjectionScope>
export const statusArgsSchema = z.tuple([z.string().min(1), z.object({ since: z.number().int().optional(),
  points: z.boolean().optional(), runId: z.string().min(1).optional() }).strict().optional()])
export const cancelArgsSchema = z.tuple([z.string().min(1)])
export const placeQuerySchema = z.object({ jobId: z.string(), runId: z.string(), view: z.enum(['pca','umap']),
  query: z.discriminatedUnion('kind', [ … ]) }).strict() satisfies z.ZodType<PlaceQueryRequest>
export function effectiveCap(a: { limit: number; d: number; matched?: number; filtered?: boolean }):
  { cap: number; reason?: CapReason }
```
Zod-parses `req` with `startRequestSchema`. `filters` is
`z.array(z.custom<FilterNode>((v) => typeof v === 'object' && v !== null)).optional()` — a deliberate shallow check: the
tree is validated by `buildFilter` (`filters.ts:252`), which rejects malformed nodes itself. Not `z.array(z.unknown())`:
its output type `unknown[]` fails `satisfies z.ZodType<ProjectionStartRequest>` (TS1360 with zod 3.25.76, U-42).
Rules (F-14): `dims ∈ {2,3}`; `method ∈ {pca,umap}`; `limit` integer 1…`MAX_ROWS` (100 001 rejected);
`vector` ∈ `config.namedVectors` names; `multiVector` true → "multi-vector spaces are not supported" (D-18, #32);
selection: `jobId === dataset.jobId && dataset.complete` (F-5), `indices` integers, in `[0, dataset.n)`, unique,
length ≥ `MIN_SELECTION`. `includeVector` = `true` when `vector === 'default'` (the single implicit space — the
`resolveIncludeVector` idiom, `searchOptions.ts:90`), else `[vector]`. `props` = `colourableProps(config)` (D-21):
every property whose `dataType[0]` (`PropertyConfig.dataType` is `string[]`, `types.ts:100`) is `text`, `boolean`, `int`
or `number`; a `[]` suffix (array) excludes it.
`effectiveCap` (U-8): `dimCap = ⌊MAX_CELLS / d⌋`; `cap = min(limit, dimCap)`, and `min(cap, FILTERED_MAX)` when
`filtered`. `reason`: `'offsetLimit'` when the filtered bound is the binding one and `matched` is unknown or above it;
else `'dimension'` when `dimCap < limit`; else `'limit'` when `matched > cap`; else none.

#### `src/main/projection/readVectors.ts` (NEW)
```ts
export interface RawObject { uuid: string; properties: Record<string, unknown>; vectors?: Record<string, unknown> }
export interface VectorSource { fetchPage(o: { after?: string; offset?: number; limit: number }): Promise<RawObject[]> }
export interface ReadArgs { source: VectorSource; vector: string; props: string[]; filtered: boolean; limit: number;
  matched?: number; knownDim?: number; metric: VectorMetric; pageTimeoutMs?: number /* 30_000 */;
  onStart(info: { dim: number; cap: number; reason?: CapReason }): Promise<void>;
  onPage(rows: Float32Array, count: number): Promise<void>; isCancelled(): boolean }
export interface ReadResult { n: number; dim: number; uuids: string[]; props: PropValue[][]; vectors: Float32Array;
  skipped: { missing: number; dim: number; nonFinite: number; zeroNorm: number }; capReason?: CapReason }
export function readVectors(a: ReadArgs): Promise<ReadResult>
```
- `VectorSource` is built by the session from the scoped collection (`scopeCollection`, `searchOptions.ts:99`):
  unfiltered → `query.fetchObjects({limit: PAGE_SIZE, after, includeVector, returnProperties: props})`; filtered →
  the same with `offset` and `filters: buildFilter(…)` (`filters.ts:252`). Every page is raced against
  `pageTimeoutMs` → rejects "page read timed out after 30 s" (F-7).
- **Order:** read pages until the **first page that holds any vector** → fix D on that page → `effectiveCap` → `onStart`
  (the session spawns there) → allocate one `Float32Array(cap * D)` → write that page's valid rows via `onPage` → loop.
  Pages before it are read and counted (`skipped.missing`) like any other (U-41). The read is `empty` (return `n = 0`
  without ever calling `onStart`, no spawn, F-18) only when the **whole** read ends with no valid row. `onPage` is awaited before the next page (backpressure through `sidecar.write`).
- **D (U-28):** `knownDim` when given (selection runs pass `dataset.dim`; Weaviate's collection config carries no
  vector dimension, so reads use the next rule); else the **modal length** of the vectors on that first page (ties → the
  length seen first). Never the first valid row.
- per object: vector = `obj.vectors[vector] ?? obj.vectors.default` (F-2); `number[][]` → counted as `dim`; skip +
  count missing / length ≠ D / non-finite. **D-19:** for `cosine`, divide the row by its L2 norm (norm 0 → skip, count
  `zeroNorm`); every other metric — `dot`, `hamming`, `l2-squared`, `manhattan` and any unknown string (U-37) → raw row.
  Push uuid, prop values (text truncated to `LABEL_MAX_CHARS`, F-17; boolean and numbers kept as is; absent → null)
  and the row **together**. Filtered pages dedupe uuids (F-3); a page error rejects with the
  Weaviate message. Stop at `cap`. The returned `capReason` is kept **only when the final `n === cap`** (U-40): a read
  that ends below its cap (e.g. 500 rows, count unknown) reports no cap, whatever `effectiveCap` predicted; when `n ===
  cap` with a full last page and no reason yet, `capReason = 'limit'` **only when `matched` is unknown or `matched > n`**
  (a collection of exactly 100 000 rows with a known count gets no reason, as in U-8 case 3).
- **Cancel vs failure (U-51):** when `isCancelled()` turns true between pages, `readVectors` stops and **resolves** with
  the partial `ReadResult` (the rows read so far, `uuids.length === n`); a page error or a rejected `onPage` **rejects**
  — the caller gets no partial result.
- Returns `vectors.subarray(0, n * D)`; asserts `uuids.length === n`. Never logs vectors or values.

#### `src/main/projection/guards.test.ts` (NEW) — mechanical rule
Scans `src/**/*.ts`, skipping `*.test.ts`, for the import/require form only:
`/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/` → only `src/main/projection/sidecar.ts`.

#### `package.json` / `vitest.config.ts` / `.github/workflows/ci.yml` (MODIFY)
Add `@vitest/coverage-v8` `5.0.5` (same as vitest), script `"test:coverage": "vitest run --coverage"`; in
`vitest.config.ts` `coverage: { provider: 'v8', include: ['src/main/projection/**', 'src/renderer/src/features/projection/*.ts'],
exclude: ['**/*.test.ts', 'src/renderer/src/features/projection/useProjectionRun.ts'], thresholds: { lines: 70 } }`
(the hook is React glue; its decisions live in pure helpers in `frame.ts`). CI job `check` runs `pnpm test:coverage`
in place of `pnpm test` (`ci.yml:22`).

## Tests (vitest, node env; fakes: `spawnFn` returning a fake child with PassThrough streams, fake `VectorSource`)

Test files (next to the code): `src/shared/projection.test.ts`, `src/main/projection/protocol.test.ts`, `binary.test.ts`,
`sidecar.test.ts`, `validate.test.ts`, `readVectors.test.ts`, `guards.test.ts`, and the existing
`src/main/weaviate/collections.test.ts` (one case added).

| Test | Given → expected | Source |
|---|---|---|
| `protocol: parses every fixture message` | `fixtures/protocol-v1/messages.ndjson` → decoded arrays equal `messages.expected.json` | S-14 |
| `protocol: encodeHeader(defaults) deep-equals header.valid.json` | `JSON.parse(encodeHeader({...HEADER_DEFAULTS, nMax:100000, dim:384, method:'umap', dims:3}))` → deep-equals the fixture | S-14 |
| `protocol: fixture hello matches PROTOCOL` | first line of `messages.ndjson` → `{type:'hello', protocol: PROTOCOL}` | F-9 |
| `F-10: should reassemble a frame split across 3 chunks` | one `frame` line cut in 3 → 1 message, coords length n×dims | F-10 |
| `F-10: should fail on a non-JSON stdout line` | `hello` then `oops` → outcome `{ok:false}`, error starts "protocol error" | F-10 |
| `F-10: should fail when a frame's coords length is not n*dims` | frame n=4 dims=2 with 7 floats → outcome `{ok:false}`, "protocol error" | F-10 |
| `F-9: should fail with a rebuild hint when hello.protocol differs` | `{"type":"hello","protocol":2}` → outcome failed, error contains "pnpm projector:build"; `kill` called once, before any further line is parsed | F-9 |
| `F-10: should kill the child on the first protocol error` | `hello`, `oops`, then a valid `progress` → `kill` called after `oops`; no message delivered for the `progress` line | F-10 |
| `protocol: MAX_CELLS matches the Rust cap` | `header.valid.at-limit.json` → `nMax * dim === MAX_CELLS`; `header.invalid.too-large.json` → `nMax * dim > MAX_CELLS`; `HEADER_DEFAULTS.nNeighbors === NN_DEFAULT` | D-8 |
| `protocol: progress samples cover every stage` | the 4 `progress` lines of `messages.ndjson` parse, stages = [pca, knn, graph, epochs] | S-14 |
| `F-8: …` ×3 | missing file → error names `WEAVIT_PROJECTOR_BIN`, the path, the build cmd · win32 → path ends `.exe` · env → a directory → rejected | F-8 |
| `F-4: should not hang waiting for drain when the child exits` | `stdin.write` returns false, child exits → `write` rejects within 100 ms | F-4 |
| `F-4: should reject the write, not throw, on EPIPE` | stdin emits `error` EPIPE → `write` rejects, no uncaught exception | F-4 |
| `F-6: …` ×3 | exit 1 + stderr "panicked at" → error contains "panicked at" · exit 0 without `done` → failed · SIGKILL → error names SIGKILL | F-6 |
| `F-7: should kill the child after 60 s without a stdout line` | fake timers, 61 s silence → kill called, outcome "no output for 60 s" | F-7 |
| `F-7: should fail when a page read exceeds the timeout` | `fetchPage` never resolves, `pageTimeoutMs` 30 000, advance 30 001 ms → `readVectors` rejects "page read timed out after 30 s" | F-7 |
| `F-2: should skip objects with a missing, wrong-length or non-finite vector and count them` | page [ok, missing, len D−1, NaN, ok] (D from the mode) → n=2, uuids=[1st,5th], skipped {missing:1, dim:1, nonFinite:1, zeroNorm:0} | F-2 |
| `F-2: should read an unnamed collection's vector from the default key` | `validateStart` on a config whose only space is `default` → `includeVector: true`; object `vectors:{default:[…]}` → row written | F-2 |
| `U-7: should skip objects without the named vector and count them` | 3 pages, 2 vectorless → n = total − 2, skipped.missing = 2 | U-7 |
| `U-41: should fix D on the first page that has vectors` | page 1 = 1 000 vectorless objects, page 2 = 1 000 valid rows of length 384 → D 384, n 1 000, `skipped.missing` 1 000, `onStart` called once, after page 2 · 3 pages all vectorless → n 0, `onStart` never called | U-41 |
| `U-40: should give no reason when the count equals the cap` | unfiltered, limit 100 000, `matched` 100 000, 100 000 rows with full pages → `capReason` undefined · `matched` 250 000 → `'limit'` | U-40, U-8 |
| `U-51: should return the partial result of a cancelled read` | `isCancelled` true after page 2 of 1 000 → resolves `{n: 2000}`, `uuids.length` 2 000, page 3 never fetched · page 3 rejects instead → `readVectors` rejects | U-51 |
| `U-40: should drop the cap reason when the read ends below the cap` | filtered, count unknown (count threw), 500 rows → `capReason` undefined · unfiltered, limit 1 000, 1 000 rows of a larger set → `capReason 'limit'` | U-40 |
| `U-42: startRequestSchema satisfies the request type` | `tsc` compiles `startRequestSchema … satisfies z.ZodType<ProjectionStartRequest>`; at run time `filters: [{}]` parses, `filters: [3]` and `filters: [null]` are rejected | U-42 |
| `U-43: should not trip the watchdog while the host is still writing` | fake timers: 10 `write`s 7 s apart, no stdout line, then a `progress` line → `kill` never called · after `end()`, 61 s silence → killed | U-43 |
| `U-28: should fix D from the modal length on page 1` | page 1 = [1 row of length 128, then 999 rows of length 384] → D = 384, n = 999, skipped.dim = 1 | U-28 |
| `U-20: should L2-normalise rows for a cosine metric` | metric cosine, rows [1,0], [100,1], [0,1] → written rows have norm 1 (±1e-6); brute-force nearest neighbour of written row 0 is row 1 | U-20 |
| `U-20: should stream raw rows for l2-squared and dot` | same rows, metric `l2-squared` → written rows equal the input exactly; metric `dot` → same | U-20 |
| `U-20: should skip a zero vector under cosine` | rows [0,0], [1,0] → n 1, skipped.zeroNorm 1 | U-20 |
| `U-37: should stream raw rows for manhattan and unknown metrics` | config distance `manhattan` → `metricOf` = 'manhattan', rows [100,1] written unchanged (not normalised) · distance `"foo"` → 'foo', raw rows · distance absent → 'cosine' | U-37 |
| `D-21: should prefetch every colourable scalar property` | properties [title text, year int, price number, ok boolean, tags text[], when date] → `props` = ['title','year','price','ok'] | D-21 |
| `scope: a ProjectionScope sample round-trips through scopeSchema` | a scope with every key set (incl. `tenant`, `filters`, `props`, `selection`) → `scopeSchema.parse(sample)` deep-equals the sample; the sample's key set equals `scopeSchema.keyof().options` | U-24 |
| `channel args: status, cancel and placeQuery are parsed` | `statusArgsSchema` rejects `[""]` and `["j", {since: 1.5}]` · `["j", {points: true, runId: "r1"}]` parses · `cancelArgsSchema` rejects `[42]` · `placeQuerySchema` rejects `view: 'tsne'` and an extra key | F-14 |
| `U-8: should compute the effective cap from n and n·d` | (limit 100 000, d 384, matched 250 000) → {cap 100 000, 'limit'} · (limit 100 000, d 1536) → {cap 66 666, 'dimension'} · (limit 100 000, d 384, matched 100 000) → {cap 100 000}, no reason · (limit 5 000, d 384, matched 20 000) → {cap 5 000, 'limit'} | U-8 |
| `U-1: should cap a filtered read at the offset limit and report matched vs read` | filtered, matched 25 000 → 10 000 rows read, `capReason 'offsetLimit'`; `effectiveCap({limit:100000, d:384, matched:25000, filtered:true})` → {cap 10 000, 'offsetLimit'} | U-1 |
| `F-3: should drop a uuid repeated across offset pages` | uuid u on pages 1 and 2 → appears once | F-3 |
| `F-3: should reject with the Weaviate message when a filtered page throws` | page 4 rejects "query maximum results exceeded" → `readVectors` rejects with that text | F-3 |
| `F-14: should reject %s before spawning` (it.each) | dims 4 · method "tsne" · limit 0 · limit 100 001 · unknown vector · multi-vector · indices [−1] · [1.5] · duplicates · 10 indices · stale jobId · incomplete dataset → throws | F-14 |
| `F-17: should truncate label values to 200 characters` | 5 000-char text prop → 200 chars in `ReadResult.props`; an int prop 1999 stays the number 1999 | F-17 |
| `U-48: should flag a multi-vector space behind a dynamic index` | `toConfig` on raw `vectorizers.v.indexConfig = {type:'dynamic', distance:'cosine', hnsw: {multiVector: {aggregation:'maxSim'}}, flat: {…}}` → `multiVector: true` | U-48 |
| `collections: should flag a multi-vector space and read its distance` | `toConfig` on raw with `vectorizers.colbert.indexConfig.multiVector = {aggregation:'maxSim'}` and `body.indexConfig.distance = 'dot'` → colbert `multiVector: true`, body `distance: 'dot'`, `multiVector: false` | D-18, D-19 |
| `decodeF32: round-trips little-endian bytes` | base64 of `Float32Array [1.5, -2, 3]` → `[1.5, -2, 3]` | S-14 |
| `guards: child_process only in sidecar.ts` | scan `src/**/*.ts` (no tests) → only `src/main/projection/sidecar.ts` matches | rule |

## Constraints
- No `any` without a comment; `import type` for types (advisory: the fork has no ESLint config, so review enforces
  these); zod for every message parsed from the child and every channel arg.
- `spawn` with array args and no `shell` — never a command string.
- Never log vectors or label values; log run ids, stages, counts, the stderr tail.
- Existing patterns: follow `src/main/weaviate/*.ts` style (module functions, `errorMessage` from `src/main/util.ts:10`),
  tests next to code. Modules ≤ 200 lines.

## Done when
`pnpm typecheck` and `pnpm test:coverage` pass (the 70 % floor applies to the projection files written so far).

<!-- plan-validate: READY 2026-11-07 sha256:554c57d7bb07 -->
