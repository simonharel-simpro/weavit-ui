# Phase 3 — Renderer: Projection tab (deck.gl 2D/3D, controls, colour, progress)

**Depends on:** Phase 2b — `window.api.projection.{start,status,cancel,placeQuery}` wired on both hosts — and Phase 2a —
the types in `src/shared/types.ts` and the constants in `src/shared/projection.ts`. **Agent:** `vite-react`. **Repo:**
worktree `/home/simon/projects/data-science/worktrees/weavit-projector` (node ≥ 22: `~/.nvm/versions/node/v22.23.1/bin`).

## Goal
A **Projection** tab in the collection view: pick a vector, a limit, an optional filter, PCA or UMAP, 2D or 3D; Run;
choose a Label and a Colour property at any time (view-only: every candidate property is prefetched, D-21); watch progress; see the points fill in (PCA) then converge (UMAP); hover for a
label, click to open the object. Works identically in Electron and web mode.

## Contracts used (from Phase 2a/2b, restated)
- `start(req) → {jobId, runId}`; `req = {source: {kind:'read', connectionId, collection, tenant?, vector, filters?, limit}
  | {kind:'selection', jobId, indices}, method: 'pca'|'umap', dims: 2|3}`. Colour and label are not run inputs (D-21).
- `status(jobId, {since?, points?}) → ProjectionStatus` = `{jobId, state:'unknown'}` **or** `{jobId, runId, state, stage?,
  progress?{done, total?}, scope, n, readComplete, skipped?{missing, dim, nonFinite, zeroNorm}, cap?{read, matched?,
  reason: 'limit'|'dimension'|'offsetLimit'}, notice?, error?, frameVersion, pca?: b64 (n×3 f32), umap?: {coords b64
  (n×dims), epoch, epochs, dims}, points?: {uuids, props, columns: PropValue[][] (one per prop, view order), indices?,
  runId}}`. Options `{since?, points?, runId?}`: `points` are those of the run named by `runId`. Coords are present only
  when `frameVersion > since`; `pca` holds only the rows covered so far (stride 3), and `placeQuery` in the PCA view
  returns 3 coordinates. `scope = {connectionId, collection, tenant?, vector, filters?,
  method, dims, limit, props, dim, metric, selection?}` echoes the run's inputs (U-24); `props` lists the prefetched
  text/boolean/int/number properties. `PropValue = string | number | boolean | null`.
- Terminal states: `done | failed | cancelled | superseded | empty | unknown`. `status` never throws for an unknown job.
- `ProjectionStage = 'reading'|'pca'|'knn'|'graph'|'epochs'`; constants `MAX_ROWS` 100 000, `LABEL_MAX_CHARS` 200 and
  `decodeF32(b64)` from `src/shared/projection.ts` (the only decoder).

## Files

#### `package.json` (MODIFY)
Add exact pins `@deck.gl/core@9.3.11`, `@deck.gl/layers@9.3.11`, `@deck.gl/react@9.3.11` and `@deck.gl/widgets@9.3.11`
(a required peer of `@deck.gl/react`), all published 2026-08-28 on npm; 9.3.12 (2026-10-30) is under two weeks old on
2026-11-07. Their peers are pinned explicitly too, because `.npmrc` sets `node-linker=hoisted`: `@luma.gl/core@9.3.6` and
`@luma.gl/engine@9.3.6` (2026-07-03; deck.gl asks `~9.3.5`), `@loaders.gl/core@4.4.5` (2026-08-21; asks `^4.4.3`).
Run `pnpm install`; commit `pnpm-lock.yaml`.

#### `src/renderer/src/store.ts` (MODIFY)
Extend `MainTab` (`store.ts:5`) with `'projection'`. Add a `projection` slice: `{ jobId?: string; runId?: string;
view: 'pca'|'umap'; dims: 2|3; labelProp?: string; colourProp?: string; breadcrumb: BreadcrumbLevel[] }` + setters
(`labelProp`/`colourProp` are view state: they survive a tab switch and never trigger a run). `BreadcrumbLevel = { jobId: string; runId:
string; label: string; indices?: number[]; pcaFrame?: string; umapFrame?: string; dims: 2|3; status: 'running'|'done'|
'failed'|'cancelled' }` (Phase 4 fills it). The active `jobId`/`runId` live here so a tab switch (panels unmount,
`CollectionView.tsx` renders one tab at a time) does not lose the run (S-6). No result cache.

#### `src/renderer/src/features/schema/CollectionView.tsx` (MODIFY)
Add `<Tabs.Tab value="projection" leftSection={<IconChartDots3 size={15} />}>Projection</Tabs.Tab>` after Stats, and
render `<ProjectionPanel connectionId collection tenant={tenantScope} />` (`tenantScope`, `CollectionView.tsx:56`) for
`mainTab === 'projection'` inside the existing `ErrorBoundary`.

#### `src/renderer/src/features/projection/useProjectionRun.ts` (NEW) — React glue only (excluded from coverage)
react-query v5 object form throughout (lockfile `@tanstack/react-query@5.101.4`):
- `useMutation({ mutationFn: (req: ProjectionStartRequest) => api.projection.start(req), onSuccess: ({jobId, runId}) =>
  setRun(jobId, runId) })`.
- `useQuery({ queryKey: ['projection', jobId, runId], queryFn: () => api.projection.status(jobId, {since:
  sinceFor(last.current.runId, runId, last.current.version)}), enabled: !!jobId, refetchInterval: pollInterval })` —
  **keyed on `runId`** (a selection keeps the jobId). `last` is a ref `{runId, version}` updated from each result, so a
  new runId always starts from `since: -1` (U-44); the cached value is `mergeStatus(prev, next)`.
- A second `useQuery({ queryKey: ['projection', runId, 'points'], queryFn: () => api.projection.status(jobId,
  {points: true, runId}), enabled: pointsEnabled(status), staleTime: Infinity, gcTime: Infinity, select: (s) =>
  acceptPoints(s, runId) })` (S-8). The host answers the points of **that** run (U-39); `acceptPoints` drops a reply
  whose `points.runId` differs from the key; `gcTime: Infinity` keeps every level's points for Back.
- `cancel()` → `api.projection.cancel(jobId)`. Returns `{ status, points, start, cancel, isRunning }`.

#### `src/renderer/src/features/projection/frame.ts` (NEW) — pure
- `isTerminal(s?: ProjectionStatus['state']): boolean` and `pollInterval(q: {state: {data?: ProjectionStatus; error:
  unknown}}): number | false` → `false` on a terminal state **and** on error, else 500 (F-12).
- `mergeStatus(prev, next)` → `next` with `prev`'s `pca`/`umap` kept when `next` omits them and `next.runId === prev.runId`.
- `sinceFor(prevRunId, runId, version)` → `-1` when `runId !== prevRunId`, else `version` (U-44).
- `pointsEnabled(status)` → `status.readComplete || status.state === 'cancelled'` (U-51): a cancelled read gets labels,
  colours and click on the rows it read, and a compute-stage failure keeps its points; a **failed read** (`failed` with
  `readComplete` false — the host dropped the dataset) never requests points. `acceptPoints(s, runId)` → `s.points` when `s.points?.runId ===
  runId`, else `undefined` (U-39).
- `pcaCount(pca: Float32Array)` → `pca.length / 3`: the number of PCA points drawn, which grows while the read and the
  fit progress (the host sends only the rows covered so far, U-45).
- `markerFor(coords: number[], view, dims)` → the PCA marker from `placeQuery` always has 3 coordinates (stride 3 like the
  PCA frame); dims 2 → its first 2 (U-53).
- `decodeCoords(b64)` = `decodeF32` from `src/shared/projection.ts`.
- `pcaView(pca: Float32Array, dims): Float32Array` — the PCA frame is always stride 3; dims 2 → columns 0–1, dims 3 →
  all 3; n = `pcaCount(pca)` (U-4, U-53).
- `matchesView(scope, view{connectionId, collection, tenant})` (U-6).
- `isStale(lastUmapDims, wantedDims, method)` — a finished UMAP view is stale when dims changed (U-4).
- `drawable(coords, dims)` → count of finite points (F-11 empty state).
- `afterDelete(view: {coords: Float32Array; n: number; deleted: ReadonlySet<string>}, uuid)` → a view with the **same**
  `coords` reference and `n` and `deleted` plus `uuid`; the tooltip then shows "deleted since this run" (U-18).

#### `src/renderer/src/features/projection/defaults.ts` (NEW) — pure (U-3, U-24, U-25, U-31)
- `defaultControls(config: CollectionConfig) → Controls {vector?, limit: MAX_ROWS, filters: [], method: 'umap', dims: 2}`:
  vector = the first entry of `config.namedVectors` (config order) whose `multiVector` is not true (U-31); none →
  `vector` undefined. `canRun(controls) → {ok: false, hint: 'no single-vector space (#32)'}` when `vector` is undefined,
  else `{ok: true}`; the Run button is disabled with that hint (U-47).
- `scalarType(p: PropertyConfig)` → `p.dataType[0]` when it has no `[]` suffix (`PropertyConfig.dataType` is `string[]`,
  `types.ts:100`), else `undefined`: array properties are excluded from Label and Colour (and are not prefetched).
- `defaultRoles(properties: PropertyConfig[]) → {labelProp?, colourProp?}`: **Label** = the first `text` property, else
  none (the tooltip shows the uuid). **Colour** = the first `text` or `boolean` property that is not the Label (a
  categorical type is the low-cardinality candidate the schema can name; a property with more than 12 values falls into
  U-17's top-12 + "other" buckets), else none → a single colour (D-12). Both are view-only (D-21).
- `controlsFromScope(scope) → Controls` (restores the run inputs after a tab switch); `isEdited(controls, scope)` → true
  when any run input (vector, limit, filters, method, dims) differs; the panel then shows "edited — Run to apply" (U-24).
  Label/Colour are never compared: changing them is instant.
- `roleColumn(points, prop)` → that prop's column from `points.columns`, or `undefined` (U-3: a role change recolours
  or relabels from the prefetched columns, never a re-run).

#### `src/renderer/src/features/projection/colors.ts` (NEW) — pure (U-17)
`colorScale(dataType: string /* scalarType(prop) */, values: PropValue[])` → `{ colorOf(i): [r,g,b], legend }`.
text/boolean → categorical: top 12 by count (ties by value ascending) + "other" + "missing" (null/absent) in a fixed
palette; int/number → sequential ramp on min/max of non-null values, missing grey — all values null, or min === max
(a constant column), → a single colour, never a division by zero (U-49); no property → one colour. Array
properties never reach it (excluded by `scalarType`). Type from the schema `dataType[0]`, never sniffed from values. `toColorAttribute(scale, n): Uint8Array` (n×3).

#### `src/renderer/src/features/projection/progress.ts` (NEW) — pure (U-19, U-15, U-29)
- `progressText(stage, done, total, locale)` covers every `ProjectionStage` (U-52): `reading` → "Reading 37 512 / 100 000";
  `pca` → "PCA 10 000 / 37 512 rows" (the sidecar's pca units: rows projected / rows received); `knn` → "kNN 42 %";
  `graph` → "Building graph"; `epochs` → "UMAP epoch 90 / 200";
  `Intl.NumberFormat(locale)`; percentages floored, never 100 % before `done`; `total` undefined (count failed, F-1) →
  "Reading 37 512" with no denominator.
- `cancelledBadge(status)` → "cancelled at " + `progressText` of the kept stage (U-15).
- `capBanner(cap, locale)` (U-29, D-8, D-10): `limit` → "100 000 / 250 000 — first 100 000 in server order (UUID
  cursor)"; `offsetLimit` → "10 000 / 25 000 — first 10 000 in server order (server limit)"; `dimension` → "66 666 /
  100 000 — first 66 666 in server order (dimension cap)" — the denominator is always `matched` (the collection or
  filter count), as for the other reasons; `matched` unknown → the text without "N /".

#### `src/renderer/src/features/projection/ProjectionCanvas.tsx` (NEW)
deck.gl `DeckGL` with `OrthographicView` (2D, `ScatterplotLayer`) or `OrbitView` (3D, `PointCloudLayer`), data as binary
attributes (`data: {length: n, attributes: {getPosition: {value: Float32Array, size: dims}, getFillColor` (Scatterplot)
/ `getColor` (PointCloud)`: {value: Uint8Array, size: 3}}}`) — no per-point JS objects. `pickable`; hover → tooltip (label
or uuid, colour value, plus `tooltipActions`); click → `onPointClick(index)`. Fit the camera to the bounds when a new
run starts; keep the camera while frames of the same run update. Props: `{coords, dims, n, colors, highlight?:
Set<number>, marker?: number[], onPointClick, onHover, onViewportChange?: (vp: Viewport) => void, tooltipActions?:
{label: string; onClick(index: number): void}[]}` — `onViewportChange` (from `onViewStateChange` / `onAfterRender`, giving
the current deck.gl `Viewport`) and `tooltipActions` exist now so Phase 4 does not modify this file. Empty-state message
when `drawable === 0`.

#### `src/renderer/src/features/projection/ProjectionPanel.tsx` (NEW) + `ProjectionControls.tsx` (NEW)
- Collection config: `useQuery({ queryKey: ['collection', connectionId, collection], queryFn: () =>
  api.schema.getCollection(connectionId, collection)})` (same key as `DataBrowser.tsx:76`) gives the vector list,
  property `dataType`s and the `FilterBuilder` `properties`.
- Controls (`ProjectionControls.tsx`, Mantine): vector `Select` (multi-vector spaces disabled with a tooltip), limit
  `NumberInput` (1–100 000), filter (`FilterBuilder` from `features/query/FilterBuilder.tsx`, `value: FilterNode[]`,
  `FilterBuilder.tsx:315`), method `SegmentedControl` PCA/UMAP, dims `SegmentedControl` 2D/3D, Run / Cancel; and,
  separate from the run inputs, **Label** `Select` and **Colour** `Select` (both clearable; options = `scope.props`;
  defaults from `defaultRoles`; stored in the slice; a change recolours/relabels at once, no start call — D-21). Initial values: `controlsFromScope`
  when the slice holds a run whose `scope` matches the open view, else `defaultControls`.
- `skippedBanner(skipped, vector)` (U-50) lists **every non-zero count** in the order missing, dim, nonFinite, zeroNorm,
  joined with ", ": "3 000 without vector `name`", "3 wrong length", "4 non-finite", "2 zero norm"; all zero → null.
- Status line: `progressText`; banners `capBanner`, `skippedBanner`, `notice`, `error` (red,
  message as is), `cancelledBadge`, `superseded`/`unknown` ("This run was replaced — Run again"), "edited — Run to apply".
  If `status.scope` doesn't match the open view → "Projection running on <collection>" and no canvas (U-6).
- View: PCA frame when `view === 'pca'` or no UMAP frame yet; UMAP frame otherwise; switching PCA↔UMAP is local; dims
  change on a finished UMAP view shows "Re-run for 3D" (U-4). The tooltip shows both the Label value (`String(v)`) and
  the Colour value (D-12).
- Clicking a point fetches the object with `useQuery({ queryKey: ['object', connectionId, collection, uuid, tenant],
  queryFn: () => api.data.getObject(connectionId, collection, uuid, tenant), enabled: !!uuid })` and opens `ObjectDrawer` (`features/data/ObjectDrawer.tsx`,
  props `ObjectDrawer.tsx:38-47`: `connectionId, collection, tenant, object: WeaviateObject, onClose, onChanged`);
  `null` → "This object no longer exists". `onChanged` after a delete calls `afterDelete` — the frame is a snapshot (U-18).
- Each file < 200 lines.

## Tests (vitest, node env — pure modules only)

| Test | Given → expected | Source |
|---|---|---|
| `U-4: should slice the 3-component PCA frame to 2D without a new run` | pca [1,2,3, 4,5,6], dims 2 → [1,2,4,5]; dims 3 → unchanged | U-4 |
| `U-53: should slice the 3-coordinate PCA marker for 2D` | `markerFor([1,2,3], 'pca', 2)` → [1,2] · dims 3 → [1,2,3] · `pcaCount` of 9 floats → 3 | U-53 |
| `U-44: should restart since at -1 on a new run` | `sinceFor('r1','r1',7)` → 7 · `sinceFor('r1','r2',7)` → −1 · `sinceFor(undefined,'r1',0)` → −1 | U-44 |
| `U-39: should drop points from another run` | `acceptPoints({points:{runId:'L2',…}}, 'L1')` → undefined · runId L1 → the points | U-39 |
| `U-51: should fetch points on any terminal state` | `pointsEnabled` {state cancelled, readComplete false} → true · {state failed, readComplete true} → true · {state reading, readComplete false} → false · {state computing, readComplete true} → true | U-51 |
| `U-51: should not request points after a failed read` | {state failed, readComplete false} → `pointsEnabled` false, so the points query stays disabled (`enabled: false`, no `status(…,{points:true})` call) | U-51 |
| `U-45: should count PCA points from the payload length` | pca of 6 000 floats (2 000 rows covered) → `pcaCount` 2 000 | U-45 |
| `U-47: should disable Run without a single-vector space` | namedVectors [colbert (multiVector)] → `defaultControls(...).vector` undefined, `canRun` → `{ok:false, hint:'no single-vector space (#32)'}` | U-47 |
| `U-49: should give a constant or all-null numeric column a single colour` | int [5, 5, null] → `colorOf(0)` equals `colorOf(1)`, every channel finite, null grey · int [null, null] → one colour, finite | U-49 |
| `U-50: should list every non-zero skipped count` | `skippedBanner({missing:0, dim:3, nonFinite:0, zeroNorm:2})` → "3 wrong length, 2 zero norm" · all zero → null | U-50 |
| `U-52: should format every stage` | pca 10 000 / 37 512, locale en → "PCA 10,000 / 37,512 rows" · graph → "Building graph" | U-52 |
| `U-4: should mark a finished UMAP view stale when dims change` | last UMAP dims 2, wanted 3, method umap → true · method pca → false | U-4 |
| `U-6: should not render a frame whose collection/tenant differs from the open view` | scope A/t1 vs view B → false · A/t2 → false · A/t1 → true | U-6 |
| `F-11: drawable counts finite points only` | [0,0, NaN,1, 2,2] dims 2 → 2 | F-11 |
| `F-12: should stop polling when status errors` | `pollInterval` with `state.error` set → false; data state `failed` → false; `unknown` → false; `computing` → 500 | F-12 |
| `frame: mergeStatus keeps coords when the next status omits them` | prev {runId r1, pca P}, next {runId r1, no pca} → pca P · next {runId r2, no pca} → no pca | payload |
| `U-18: should keep the frame unchanged after a delete from the drawer` | `afterDelete({coords C, n 3, deleted ∅}, 'u')` → `coords` is C (same reference), n 3, `deleted.has('u')` | U-18 |
| `U-3: should default the label to the first text property, else uuid` | [int n, text title, text body] → label 'title' · [int n] → label undefined | U-3 |
| `U-3: should recolour from the prefetched column without a re-run` | points {props [title, year], columns [T, Y]} → `roleColumn(points, 'year')` = Y; `isEdited(controls, scope)` stays false after a Colour change | U-3, D-21 |
| `defaults: array properties are never offered` | [tags: `text[]`, title: `text`] → `scalarType(tags)` undefined; `defaultRoles` → label title, no colour | D-21 |
| `U-25: should assign Colour and Label roles from the schema` | props [title: text, category: text] → `{labelProp:'title', colourProp:'category'}` · [title: text] → `{labelProp:'title'}`, no colour · [n: int] → `{}` | U-25 |
| `U-31: should default to UMAP, 2D and the first single-vector space` | namedVectors [colbert (multiVector), title_vec, body_vec] → vector 'title_vec', method 'umap', dims 2, limit 100 000 | U-31 |
| `U-24: should restore the controls from the run scope` | scope {vector v, filters F, method pca, dims 3, limit 5 000, props […]} → controls equal {v, F, pca, 3, 5 000}; `isEdited` after changing limit → true | U-24 |
| `U-17: should bucket top-12 categories, then other, with missing separate` | categories c01…c11 with counts 20, 19, …, 10; "k" ×5 and "m" ×5 (the tie at rank 12); "z" ×1; 3 nulls → named = c01…c11 + "k" ("k" < "m"); "other" = {m, z} (6 values); "missing" = 3; same input twice → same colours | U-17 |
| `U-17: should ramp numerics with nulls grey` | int [0, 50, 100, null] → first ≠ last, null = grey | U-17 |
| `U-19: should format progress per stage and never show 100% before done` | knn 99 999 / 100 000 → "kNN 99 %" · reading 37 512 / 100 000, locale en → "Reading 37,512 / 100,000" · epochs 90/200 → "UMAP epoch 90 / 200" | U-19 |
| `F-1: should format reading progress without a total` | reading 37 512, total undefined, locale en → "Reading 37,512" | F-1 |
| `U-15: should show the cancelled badge with the kept stage` | {state cancelled, stage epochs, progress 90/200} → "cancelled at UMAP epoch 90 / 200" | U-15 |
| `U-29: should state the order basis in the cap banner` | locale en: {read 100000, matched 250000, limit} → "100,000 / 250,000 — first 100,000 in server order (UUID cursor)" · {read 10000, matched 25000, offsetLimit} → "10,000 / 25,000 — first 10,000 in server order (server limit)" · {read 100000, limit, matched undefined} → "first 100,000 in server order (UUID cursor)" · {read 66666, matched 100000, dimension} → "66,666 / 100,000 — first 66,666 in server order (dimension cap)" · {read 66666, dimension, matched undefined} → "first 66,666 in server order (dimension cap)" | U-29 |

## Constraints
- Follow existing feature folders (`features/backup`, `features/stats`): Mantine components, `@tabler/icons-react`, react-query.
- No `useEffect` for data fetching; each `useEffect` has a `// WHY:` comment.
- No per-point object arrays for 100k points — typed arrays end to end.
- Never put label values in console output. No `any`, `import type` for types (advisory: no ESLint config in the fork).

## Done when
`pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `pnpm web:build` pass. Manual check in web mode **from this
worktree** (data-lab's `tools/weavit-web.sh` serves the submodule at 5f09642, without this branch): `pnpm projector:build
&& WEAVIT_SEED_DATALAB=1 pnpm web`, then `http://127.0.0.1:3080/?collection=<MiniRag collection>`: Projection tab runs PCA
then UMAP in 2D and 3D, hover shows the label and colour value, changing Colour recolours with no new run, click opens
the drawer, Cancel keeps the last frame, a tab switch and back restores the controls. Use Chrome (claude-in-chrome) for the check, not Playwright.

<!-- plan-validate: READY 2026-11-07 sha256:1a44c7034374 -->
