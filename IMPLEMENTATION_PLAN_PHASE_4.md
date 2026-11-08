# Phase 4 — Selection (lasso → UMAP on subset, breadcrumb) + query overlay

**Depends on:** Phase 3 (`ProjectionPanel`, `ProjectionCanvas` with its `highlight`/`marker`/`onViewportChange`/
`tooltipActions` props, `colors.ts`, the `projection` zustand slice with `breadcrumb`) and Phase 2b (`projection:start`
with a `selection` source; `projection:placeQuery` bound to a `runId`). **Agent:** `vite-react`. **Repo:** worktree
`/home/simon/projects/data-science/worktrees/weavit-projector`.

## Goal
1. **Selection:** in a 2D view, draw a lasso around points → "UMAP on selection (8 214 points)" → a new view of just
   those points (its PCA is refitted on the subset, D-11), with a breadcrumb back to the parent views. Lasso is hidden
   in 3D (D-14, #31): a hint says "switch to 2D to select".
2. **Query overlay:** a search box over the projection. The hits are highlighted; a marker shows where the query lands —
   exact for a vector query in the PCA view or a point used as query, approximate (badged) otherwise.

## Contracts used (restated)
- `api.projection.start({source: {kind:'selection', jobId, indices /* root-relative */}, method:'umap', dims:2|3})` →
  `{jobId, runId}` (same `jobId`, new `runId`). The host rejects fewer than `MIN_SELECTION` (16) indices, a stale
  `jobId`, or an incomplete dataset (a cancelled read).
- `api.projection.placeQuery({jobId, runId, view:'pca'|'umap', query})` with `query` = `{kind:'vector', vector}` |
  `{kind:'object', uuid}` | `{kind:'hits', metric:'distance'|'score', hits:[{uuid, distance?, score?}]}` →
  `{placed, reason?, coords?, approximate, method?: 'basis'|'knn'|'centroid'|'mean'|'point', inView?, total?}`. The host
  keeps a placement context per `runId` of the current dataset; an unknown `runId` → `{placed:false, reason:'run not
  available'}`. Each context indexes its own points (`uuids[indices[i]] → i`): an object outside the selection →
  `{placed:false, reason:'point not in this selection'}` (U-33).
  `approximate` is false only for a vector query in the PCA view and for the `object` kind (U-21). Maths live in the host.
- `status.scope` = `{connectionId, collection, tenant?, vector, filters?, method, dims, limit, props, dim, metric,
  selection?}`; `status.runId`; `status.readComplete`; `status.umap.epoch`. `points.uuids` of a selection = its subset in
  view order, `points.indices` = root indices, `points.columns` = one prefetched column per prop (Label/Colour are
  view-only, D-21; `labelProp`/`colourProp` live in the zustand slice). `status(jobId, {points: true, runId})` returns the
  points of the run named by `runId` (root or a level) with `points.runId` set; the renderer drops a reply whose `runId`
  differs from its query key; points queries use `gcTime: Infinity` (U-39).
- `api.query.search(req: SearchRequest)` — existing (`src/shared/types.ts:449-498`): `type: SearchType` (`'nearText' |
  'nearVector' | 'nearObject' | 'bm25' | 'hybrid' | …`, `types.ts:331`), `includeVector: boolean`, `queryText`,
  `queryVector` (**a JSON string**), `queryObjectId`, `targetVector`, `tenant`, `filters` (**required**, `types.ts:502`),
  `limit`. `targetVector` is passed through as given (`searchOptions.ts:161`), so the implicit `default` space must omit it.
- Constants from `src/shared/projection.ts`: `MIN_SELECTION` 16, `NN_DEFAULT` 15, `OVERLAY_K {min 1, max 100, default 20}`.

## Files

#### `src/renderer/src/features/projection/lasso.ts` (NEW) — pure (S-10, U-30)
`pointsInPolygon(screenXY: Float32Array, n, polygon: [number, number][]): number[]` — even-odd ray casting on screen
coordinates; returns view-relative indices in ascending order. `toRootIndices(viewIndices, levelIndices?)` — maps a
nested selection to root-dataset indices (U-14); at the root level, identity. `canSelect(status)` reads
`status.readComplete`, never `stage`: `readComplete` false and state `cancelled` → `{canSelect: false, hint: 'read was
cancelled — Run again to select'}`; a run in flight → `{canSelect: false}`; else `{canSelect: true}` (U-30).

#### `src/renderer/src/features/projection/overlay.ts` (NEW) — pure
```ts
export interface OverlayInput { mode: 'nearText' | 'bm25' | 'hybrid' | 'vector' | 'point'; text?: string;
  vector?: number[]; uuid?: string }
export function overlaySearchRequest(scope: ProjectionScope, input: OverlayInput, k?: number): SearchRequest
export function hitsForPlacement(results: SearchResult, mode: OverlayInput['mode'], sourceUuid?: string): ProjectionQuery
export function highlightSet(hitUuids: string[], uuidIndex: Map<string, number>): { indices: Set<number>; inView: number; total: number }
export function approximateBadge(r: PlaceQueryResult): string | null
export function placementKey(level: { runId: string }, view: 'pca' | 'umap', dims: 2 | 3, epoch?: number): unknown[]
```
- `overlaySearchRequest`: always `connectionId`, `collection`, the run's `tenant`, `filters: scope.filters ?? []` (U-5,
  U-24), `includeVector: false`, `limit` = k (default 20, clamped 1–100, U-12); `targetVector` = the projected vector for
  every mode except `bm25`, and omitted when `scope.vector === 'default'` (the implicit unnamed space). `nearText`/`bm25`/`hybrid` → `type` = the mode, `queryText`; `vector` → `type:'nearVector'`,
  `queryVector: JSON.stringify(vector)`; `point` → `type:'nearObject'`, `queryObjectId`, `limit` k + 1 (U-13).
- `hitsForPlacement`: drops the source uuid for a point query and returns `{kind:'object', uuid}` for the marker (U-13);
  a vector query → `{kind:'vector', vector}`; text modes → `{kind:'hits', metric}`: `distance` for nearText, `score` for
  bm25/hybrid (U-10).
- `approximateBadge` (U-21, U-32): `method 'knn'` → `` `approximate (${NN_DEFAULT}-NN)` `` ("approximate (15-NN)");
  `'centroid'` → "approximate (hit centroid)"; `'mean'` → "approximate (unweighted mean of hits)"; else null.
- `highlightSet` uses the uuid → index map built from `points.uuids` of the level on screen, so a selection highlights
  local indices and ignores hits outside it (U-33).
- `placementKey` (U-23): the react-query key of the placement call — `['placeQuery', runId, view, dims, epoch]` — so a
  new frame epoch, a PCA↔UMAP switch or a dims change re-calls `placeQuery` with the current `runId`/`view`.

#### `src/renderer/src/features/projection/breadcrumb.ts` (NEW) — pure (U-14, U-22, U-27)
- `pushLevel(levels, level)` — a level is pushed **when its run starts** (`status: 'running'`).
- `settleLevel(levels, runId, outcome: 'done' | 'failed' | 'cancelled', frames?: {pcaFrame?, umapFrame?})` — marks it; a
  failed/cancelled level stays visible with its mark. Each level stores its PCA frame **and** its UMAP frame.
- `back(levels) → {levels, cancelJobId?}` — pops the top level; when that level is still `running`, returns its jobId so
  the panel cancels the in-flight child run.
- `rerunLevel(levels, index, newRunId)` — replaces that level in place: same `indices`, new `runId`, `status:'running'`.
- `shouldDraw(status, level)` → `status.runId === level.runId` (U-22): the canvas never draws another level's frame.
- `selectionRequest(jobId, rootIndices, dims)` → the start request; `dims` = the **current** dims control (U-27).
- `runAction(levels, current, controls, scope) → {kind:'root'} | {kind:'rerunLevel', index} | {kind:'confirmRoot',
  levels: number}` (D-20): at the root → `root`. Below the root: only `method`/`dims` edited → `rerunLevel(current)` (same
  indices); any root input edited (`filters`, `limit`, `vector`, `tenant`) → `confirmRoot` — the panel shows "this clears
  the breadcrumb (N levels)"; accept → breadcrumb reset to [All] and a root start; decline → nothing is sent.
- `resolveRun(action, confirmed: boolean | undefined, ctx: {jobId, levels, controls, scope}) → {request:
  ProjectionStartRequest | null; levels: BreadcrumbLevel[]}` (U-54) — the pure decision the Run button executes:
  `rerunLevel` → the selection request (level indices, current method/dims) and the level replaced; `confirmRoot` with
  `confirmed` undefined or false → `{request: null}`, levels unchanged; with `true` → the root read request and `[All]`;
  `root` → the root read request.
- `onColourChange(state, prop) → {start: null; colourProp: prop}` (U-54) — a Colour or Label change never yields a start
  request at any level (D-21).

#### `src/renderer/src/features/projection/colors.ts` (MODIFY) — U-26
`colorScale(dataType, values, inherited?: Map<string, [number, number, number]>)`: with `inherited` (the root level's
category → colour map), categories keep the root's colour; a category the root map lacks takes the "other" colour.
`colorScale(...).categories` exposes that map so the root level can hand it down. **Numeric ramps inherit the root's
`{min, max}`** (`colorScale(...).range`, passed as `inheritedRange`) so a value has the same colour at every level (U-36).
The root maps are recomputed from the **root run's** prefetched column — the points query with `runId` = the root
level's runId, not the level on screen (U-39) — whenever Colour changes, at any level, with no start call (D-21).

#### `src/renderer/src/features/projection/SelectionLayer.tsx` (NEW)
Lasso interaction on top of `ProjectionCanvas` in 2D: pointer-down/move/up draws a polygon (SVG overlay); on release it
projects the view's coordinates to screen with the `Viewport` received from `ProjectionCanvas`'s `onViewportChange`
(`viewport.project`) and calls `pointsInPolygon`. Shows the count and the button "UMAP on selection" (disabled below
`MIN_SELECTION` points, tooltip "needs at least 16 points"; disabled with the `canSelect` hint after a cancelled read).
Esc clears.

#### `src/renderer/src/features/projection/QueryOverlay.tsx` (NEW)
Compact panel: search-type picker `SegmentedControl` (nearText / BM25 / Hybrid / Vector / From point), a text input or a
JSON vector textarea (validated as a number array of length `scope.dim` before sending), k `NumberInput`, Search /
Clear. "From point" is armed from the `ProjectionCanvas` `tooltipActions` entry "Use as query". Shows "14 / 20 hits in
view", the `approximateBadge` text, or the host's `reason` when nothing could be placed. Passes `highlight` and `marker`
to the canvas; the marker is a distinct shape/colour drawn above the points. The placement query uses `placementKey`.

#### `src/renderer/src/features/projection/ProjectionPanel.tsx` (MODIFY)
- Breadcrumb (Mantine `Breadcrumbs`): "All (100 000)" › "Selection 1 (8 214)" › … driven by `breadcrumb.ts`; levels live
  in the zustand slice as `{jobId, runId, label, indices (root-relative), pcaFrame, umapFrame, dims, status}`, so Back
  shows the stored frame without a new run (U-14). A new root Run clears the breadcrumb; changing collection/tenant
  clears it too. Each level after the root uses the root's colour map (U-26).
- Wire `SelectionLayer` (2D only) and `QueryOverlay`; clear the overlay when the run changes; draw only when
  `shouldDraw(status, currentLevel)`.
- The Run button calls `runAction` (D-20): `rerunLevel` → selection start with the level's indices and the current
  method/dims; `confirmRoot` → a Mantine `Modal` from `@mantine/core` (as in `features/schema/DeleteCollectionModal.tsx`; `@mantine/modals` is not a dependency) "this clears the breadcrumb (N levels)" with Cancel / Clear and run.

#### `src/renderer/src/store.ts` (MODIFY) — breadcrumb actions calling the `breadcrumb.ts` helpers (push, settle, back, rerun, reset).

`ProjectionCanvas.tsx` is not modified: the viewport and tooltip-action props were laid in Phase 3.

## Tests (vitest, node env — pure modules)

Test files: `src/renderer/src/features/projection/lasso.test.ts`, `overlay.test.ts`, `breadcrumb.test.ts`, and new cases
in the existing `colors.test.ts`.

| Test | Given → expected | Source |
|---|---|---|
| `lasso: points inside a square` | 5 points, 3 inside the unit square polygon → [0, 2, 4] (ascending) | S-10 |
| `lasso: point on a concave polygon notch is outside` | U-shaped polygon, point in the notch → not selected | S-10 |
| `U-14: should map level-2 lasso indices to root indices` | level-1 indices [10, 20, 30], level-2 lasso [0, 2] → [10, 30] | U-14 |
| `U-5: should build the overlay search with the run's tenant, vector and filter` | scope {connectionId c, collection C, tenant 't1', vector 'title_vec', filters F}, input {mode nearText, text "pump"} → deep-equals `{connectionId:c, collection:C, type:'nearText', tenant:'t1', targetVector:'title_vec', filters:F, queryText:'pump', limit:20, includeVector:false}` | U-5 |
| `overlay: vector and bm25 requests` | {mode vector, vector [1,2]} → `type:'nearVector'`, `queryVector:'[1,2]'` · {mode bm25} → `type:'bm25'`, no `targetVector` · scope.vector `'default'`, nearText → no `targetVector` · scope without filters → `filters: []` | U-5 |
| `U-13: should drop the source object from nearObject hits and mark it exactly` | point P, hits [P, a, b] → `limit` k+1 requested, `type:'nearObject'`, marker query `{kind:'object', uuid:P}`, highlighted [a, b] | U-13 |
| `U-12: highlight only hits present in the view` | 20 hit uuids, 14 in the view index → 14 indices, `{inView:14, total:20}` | U-12 |
| `U-10: metric per search mode` | nearText → 'distance' · bm25 → 'score' · hybrid → 'score' | U-10 |
| `overlay: k clamped` | k 0 → 1 · k 500 → 100 · undefined → 20 | U-12 |
| `overlay: vector input validated` | "[1, 2, x]" → error "not a number array" · length 128 vs scope.dim 384 → error "dimension 128, expected 384" | F-15 |
| `U-21: should badge approximate placements` | {method knn, approximate true} → "approximate (15-NN)" · {method centroid} → "approximate (hit centroid)" · {method mean} → "approximate (unweighted mean of hits)" · {method basis, approximate false} → null | U-21, U-32 |
| `U-33: should highlight a selection's local index only` | level points.uuids = root uuids of rows [10, 20, 30]; hits [uuid of row 20, uuid of row 5] → indices {1}, `{inView:1, total:2}` | U-33 |
| `U-34: should re-run the level when only dims changed` | levels [All, S1, S2], current 2, dims 2 → 3 → `{kind:'rerunLevel', index:2}` | U-34, D-20 |
| `U-34: should confirm before a root re-run from below the root` | levels [All, S1, S2], filter edited → `{kind:'confirmRoot', levels:3}`; `resolveRun(that, true, ctx)` → a `read` request and levels [All] · `resolveRun(that, false, ctx)` → `{request: null}`, levels [All, S1, S2] · `resolveRun({kind:'rerunLevel', index:2}, undefined, ctx)` → a `selection` request with S2's indices and dims 3 | U-34, U-54 |
| `U-35: should recolour at level 1 without a run` | `onColourChange({level: 1, …}, 'year')` → `{start: null, colourProp: 'year'}`; `colorScale('int', rootYearColumn)` recomputed from the root points | U-35, U-54 |
| `U-39: should build root colour maps from the root run's points` | root points (runId L1) categories {a, b, c}; level L2 points only {b} → the map handed to L2 has a, b and c | U-39 |
| `U-36: should keep root numeric colours in a drill-down` | root `year` range [1990, 2020]; level values 2000–2010 with `inheritedRange` → `colorOf(2000)` equals the root's colour for 2000 | U-36 |
| `U-22: should not draw a status from another level` | status.runId L2, current level runId L1 → `shouldDraw` false · L1/L1 → true | U-22 |
| `U-22: should keep both frames per level for Back` | `settleLevel` with {pcaFrame P, umapFrame U} → the level holds P and U | U-22 |
| `U-23: should re-place the overlay on a new frame epoch, view or dims` | key at (r1, umap, 2, epoch 50) vs a frame at epoch 60 → keys differ and the new key carries r1/umap · view pca → differs · dims 3 → differs · same inputs → equal | U-23 |
| `U-26: should inherit the root's category colours in a drill-down` | root map {a: red, b: blue}; child values [b, c] → b blue, c = the "other" colour | U-26 |
| `U-27: should push a level when its run starts and mark it when it fails` | [All] + start Sel1 → [All, Sel1 running] · `settleLevel(Sel1, 'failed')` → Sel1 kept, status failed | U-27 |
| `U-27: should cancel and pop an in-flight child on Back` | [All, Sel1 running] → `back` → [All], `cancelJobId` = Sel1.jobId · [All, Sel1 done] → [All], no cancel | U-27 |
| `U-27: should replace a level on re-run with the same indices` | [All, Sel1 {indices [3,5,…], runId r2}] → `rerunLevel(1, r3)` → length 2, level 1 runId r3, same indices, running | U-27 |
| `U-27: a selection run uses the current dims control` | dims control 3 → `selectionRequest(j, idx, 3).dims` = 3 | U-27 |
| `U-30: should block selection after a cancelled read` | {state cancelled, readComplete false} → `{canSelect:false, hint:'read was cancelled — Run again to select'}` · {state cancelled, readComplete true, stage epochs} → `{canSelect:true}` · {state done, readComplete true} → `{canSelect:true}` | U-30 |

## Constraints
- Same as Phase 3: Mantine, react-query, typed arrays, `// WHY:` on every `useEffect`, files < 200 lines; no `any`,
  `import type` (advisory: no ESLint config in the fork).
- The overlay never searches outside the run's tenant / vector / filter (U-5) — no override in the UI.
- No placement maths in the renderer: it only calls `placeQuery` and draws.

## Done when
`pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, `pnpm web:build` pass. Manual check in web mode **from this
worktree** (`pnpm projector:build && WEAVIT_SEED_DATALAB=1 pnpm web`, `http://127.0.0.1:3080`; data-lab's
`tools/weavit-web.sh` serves the submodule at 5f09642, without this branch) with Chrome on a MiniRag collection: lasso a cluster in 2D PCA → UMAP on selection → breadcrumb back (an in-flight selection is cancelled);
text query shows highlighted hits + an "approximate (hit centroid)" marker that moves with new frames; "Use as query" on a
point marks it exactly; a pasted vector of the wrong length is refused.

<!-- plan-validate: READY 2026-11-07 sha256:0604b4d8028f -->
