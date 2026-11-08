# Implementation Plan — Embedding projector (Weavit UI fork)

**Date:** 2026-11-06 · **Branch:** `feat/embedding-projector` (from `feat/web-mode` @ 5f09642) · **Phases:** 5 in the fork (Phase 2 split into 2a/2b) + 1 in data-lab · **Revised:** 2026-11-07 after `/plan-validate`

> ⚠️ Planned with review debt: 3 cycles un-reviewed in data-lab (feat/weavit-web #19, feat/openrouter-default #17,
> feat/voice-arch #26) since the 2026-11-04 review (user override 2026-11-06).

Issue refs (`#29`–`#32`) point at `simonharel-simpro/data-lab`, which tracks the fork's work (the fork has no
tracker of its own). Docs and ADRs live in data-lab (`ARCHITECTURE.md` §Weaviate browser, `decisions.md`).

## Feature

A **Projection** tab in Weavit UI that projects a collection's embeddings in **2D and 3D**: PCA (instant, fills while
reading) and UMAP (Rust, ~40 s for 100k, ~3 s for a 20k selection). Target **100k vectors**. The user lassoes a cluster
(2D) and runs UMAP on that selection, or runs on a Weaviate filter. A search can be overlaid: hits highlighted, the
query marked (exact for vector queries, approximate for text queries).

Measured on 6 cores (WSL), 100k × 384: Weaviate cursor read 5.8 s (page 1000), exact kNN on PCA-50 17.6 s, umap-rs
200 epochs 12–15 s. Rejected: umap-js (5k = 16 s), umap-learn (35 s + a Python service), HNSW (recall@15 0.36–0.73).

## Phases

| Phase | Title | Files (new / mod) | Agent | Depends on |
|---|---|---|---|---|
| 1 | Rust sidecar `weavit-projector` + Rust CI job + local pre-push hooks | 14 / 4 | `rust-cli` | — |
| 2a | Host core: shared contract + constants, protocol, binary, sidecar, vector read (D-19), validation | 6 + 7 tests / 8 | `general-purpose` | Phase 1 protocol + fixtures |
| 2b | Host session: run transitions, per-runId placement, channels, host wiring | 5 + 3 tests / 4 | `general-purpose` | Phase 2a |
| 3 | Renderer: Projection tab (deck.gl 2D/3D, controls, colour, progress) | 8 + 4 tests / 3 | `vite-react` | Phase 2b channels, Phase 2a types |
| 4 | Selection (lasso → UMAP on subset, breadcrumb, Run below the root) + query overlay | 5 + 3 tests / 4 | `vite-react` | Phase 3 tab + canvas props, Phase 2b `placeQuery` |
| 5 | data-lab: ADRs, ARCHITECTURE.md, `tools/weavit-web.sh` builds the binary, submodule bump | 0 / 4 | `general-purpose` | Phase 4 merged in the fork |

### Cross-phase contracts
- **P1 → P2:** protocol v1 (stdin header + f32 rows until EOF; stdout NDJSON `hello`, `progress`, `basis`, `pcaChunk`,
  `pca50`, `frame`, `notice`, `done`, `error`) and the fixture dir `native/projector/fixtures/protocol-v1/`, which both
  test suites assert (S-14). Binary path `native/projector/target/release/weavit-projector[.exe]`. Exit codes 0 / 2
  header / 3 broken pipe / 1 other.
- **P2a → P2b/P3/P4:** types in `src/shared/types.ts` (`ProjectionStatus` = known | `{jobId, state:'unknown'}`, the
  known branch carrying `n` and `readComplete` and `points.columns` (every prefetched prop, D-21);
  `ProjectionScope` echoing every run input, `ProjectionStage`, `CapReason`, `VectorMetric`) and the constants +
  `decodeF32` in `src/shared/projection.ts` (single source for main and renderer); `validateStart`, `readVectors`,
  `startSidecar`.
- **P2b → P3/P4:** channels `projection:start | status | cancel | placeQuery`; `start → {jobId, runId}`;
  `status(jobId, {since?, points?})`; `placeQuery` bound to a `runId` (one placement context per run of the dataset).
- **P3 → P4:** `ProjectionPanel` view state (current view, frame, uuids), the `projection` zustand slice (`jobId`,
  `runId`, `breadcrumb`), `ProjectionCanvas` props `onViewportChange` and `tooltipActions`, `colors.ts`.

## Existing Equivalents

| Mechanism | Existing code (path:line) | Plan |
|---|---|---|
| Read vectors | `fetchObjects({after, limit})` idiom `src/main/weaviate/data.ts:52-53`. NOT `exportObjects` (`data.ts:273`): `collection.iterator` pages at a fixed 100 (weaviate-client `iterator/index.js:2`) and `mapObject`→`normalizeForIpc` JSON round-trips every vector (`src/main/util.ts:4-8`) | new lean loop, page 1000, preallocated `Float32Array` |
| Count N | `aggregate.overAll` (`data.ts:61-71`), may fail | progress total only, never required (F-1) |
| Tenant / vector name | `scopeCollection` (`searchOptions.ts:99`), `resolveIncludeVector` (`searchOptions.ts:90`) | reuse |
| Filter | `buildFilter` (`filters.ts`); cursor can't carry a filter (`data.ts:34-40`) → offset paging (`data.ts:285-303`); `FilterBuilder.tsx:315` (`FilterNode[]`) | filter is a Run input; offset path capped (D-10) |
| Cancel | `cancellable` + `inFlight` (`registry.ts:66-78`) | same idea: kill the run's child |
| Poll a long job | backup `createStatus` (`backup.ts:70`) + `BackupPanel.tsx:92-100` `refetchInterval` | same, but polling stops on every terminal state and on error (F-12) |
| Object detail | `ObjectDrawer.tsx` | reuse on point click |
| Search | `query.search`; `SearchRequest` has `queryText` / `queryVector` / `queryObjectId` (`types.ts:449-498`); hits carry distance/score (`searchOptions.ts:19-21,209`) | reuse for the overlay |
| Multi-vector rule | `isMultiVector` (`VectorView.tsx:10-12`) sniffs values; the config knows it: `indexConfig.multiVector` (weaviate-client `config/types/vectorIndex.d.ts:12`) | host reads config: new `NamedVectorConfig.multiVector` set in `extractNamedVectors` (`collections.ts:54`) |
| Distance metric | `indexConfig` passed through verbatim (`collections.ts:61` named, `:74` unnamed `default`); `distance` per weaviate-client `VectorDistance` | new `NamedVectorConfig.distance`; drives D-19 |
| Session wiring | `registerHandlers(on)` (`registry.ts:96`), `registerIpc()` (`electron.ts:4`, called at `index.ts:86`), web `registerHandlers` (`web/main.ts:40`) | add a `deps: {projection}` argument; each host creates the session |
| Transport | `CH` (`channels.ts`), `buildApi` (`api.ts`), registry; web host is request/response, JSON replies (`server.ts:110`), loopback single user (`server.ts:55-64`) | 4 new channels, no new transport |
| App root | web host from `out/web/server` (`src/web/main.ts:44`); Electron from `out/main` | each host passes its root (S-12) |
| Subprocess / WebGL / Rust | none | new: `src/main/projection/sidecar.ts`, deck.gl 9.3.11, `native/projector` |

## Scope Decisions

| # | Type | What | Tracker | Approved |
|---|------|------|---------|----------|
| D-1 | decision | Compute in a Rust sidecar binary spawned by the host (not napi, not WASM, not Python) | — | — |
| D-2 | decision | Exact kNN by blocked GEMM on PCA-50 instead of HNSW (recall@15 measured 0.36–0.73) | — | — |
| D-3 | decision | UMAP runs on PCA-50 coords and is initialised from the PCA components | — | — |
| D-4 | decision | Progress by polling one host session slot; a new start kills the running child | — | — |
| D-5 | decision | Query marker exact in the PCA view (basis projection), distance-weighted 15-NN in the UMAP view | — | user, AskUserQuestion 2026-11-06 |
| D-6 | decision | Text queries (no vector) → marker at the weighted centroid of in-view hits, labelled "approximate" | — | — |
| D-7 | defer | Bundling the binary into electron-builder installers; a packaged app shows "projector binary not found" | #29 | — |
| D-8 | decision | Cap 100 000 rows and n·d ≤ 100 000 × 1024; first N in UUID cursor order; the banner states the order basis: "100 000 / N — first 100 000 in server order (UUID cursor)" | — | user, AskUserQuestion 2026-11-07 |
| D-9 | decision | Selection modes: lasso (2D) and a filter on Run; no read-batch ranges | — | user, AskUserQuestion 2026-11-06 |
| D-10 | cut | Filtered runs capped at the server's offset limit (10 000); the banner states the order basis: "10 000 / N — first 10 000 in server order (server limit)" | #30 | user, AskUserQuestion 2026-11-07 |
| D-11 | decision | UMAP on a selection refits PCA on the subset; the active run's basis places queries | — | user, AskUserQuestion 2026-11-06 |
| D-12 | decision | Two explicit roles, **view-only** since D-21: a "Colour" select and a "Label" select over the prefetched properties; Colour defaults to the first low-cardinality (categorical: text/boolean) property other than the Label, else a single colour; Label defaults to the first text property, else uuid; the tooltip shows both | — | user, AskUserQuestion 2026-11-07 |
| D-13 | decision | PCA always emits 3 components (2D↔3D instant); a UMAP dims change marks the view stale until Run | — | user, AskUserQuestion 2026-11-06 |
| D-14 | defer | Selecting points directly in a 3D view (lasso hidden in 3D; switch to 2D) | #31 | — |
| D-15 | decision | Host validates each vector (present, length D, finite) and skips + counts bad rows; Rust checks shape and finiteness only | — | — |
| D-16 | decision | The sidecar emits PCA-50 coords once per run (`pca50`) so placement never projects 100k vectors in the host | — | — |
| D-17 | decision | Local hook runner: Phase 1 adds a minimal `.pre-commit-config.yaml` at the pre-push stage (typecheck, vitest, `cargo fmt --check`, `cargo clippy -D warnings` on `native/projector`); `pre-commit` goes in the README install notes; CI stays the gate | — | user, AskUserQuestion 2026-11-07 |
| D-18 | defer | Projecting multi-vector (ColBERT-style) spaces; v1 rejects them at start with an explicit message | #32 | — |
| D-19 | decision | Metric from the vector index config (`collections.ts:74` `raw.vectorIndexConfig`, `:61` for named vectors): cosine → the host L2-normalises rows and query vectors before streaming and before `placeExactPca`; every other metric (dot, hamming, manhattan, unknown strings — U-37) → raw rows + notice "<metric> metric: Euclidean layout" (none for l2-squared); hit weights: cosine `max(ε, 1 − d)`, otherwise the sign-safe `(d_max − d) + ε` (U-32) | — | user, AskUserQuestion 2026-11-07 |
| D-20 | decision | Run below the root: if only method or dims were edited, Run = `rerunLevel` (replaces the current level, same indices); if a root input was edited (filter, limit, vector, tenant), confirm "this clears the breadcrumb (N levels)", then a root Run (decline → nothing sent) | — | user, AskUserQuestion 2026-11-07 |
| D-21 | decision | Colour and label below the root: the read also fetches every text, boolean, int and number property (text truncated at 200 chars, arrays excluded); changing Colour or Label recolours/relabels instantly at any level with no spawn — they are no longer run inputs; the memory cost goes in the ADR | — | user, AskUserQuestion 2026-11-07 |

## Simplicity Review

Before → after: 5 fork phases → 4 fork phases + 1 data-lab phase · ~11 mechanisms → 8 (reviewer: fable, 2026-11-06)

| # | Action | Class | What | Disposition |
|---|--------|-------|------|-------------|
| S-1 | add | — | Don't read through `exportObjects`/iterator/`normalizeForIpc`; lean `fetchObjects` loop | applied, Phase 2a |
| S-2 | simplify | mechanism | Read fully, then spawn (no progressive PCA) | kept by user (progressive fill stays) |
| S-3 | simplify | mechanism | One session slot instead of a job registry + TTL + concurrency cap | applied (D-4) |
| S-4 | simplify | mechanism | One centroid rule for every query type, no `placeQuery`/`basis` | kept by user (D-5) |
| S-5 | simplify | mechanism | Filter is a Run input, not a selection mode | applied (D-9) |
| S-6 | drop | mechanism | react-query result cache; active `jobId` in zustand instead | applied, Phase 3 |
| S-7 | simplify | mechanism | Build/CI with the crate in Phase 1; docs in a data-lab phase | applied |
| S-8 | add | — | `status(jobId, {points})` idempotent | applied, Phase 2b |
| S-9 | add | — | Caps and argument validation owned by the host | applied, Phase 2a |
| S-10 | keep | — | Exact 2D point-in-polygon lasso | Phase 4 |
| S-11 | keep | — | NDJSON + base64 frames | Phase 1 |
| S-12 | keep | — | Env override + root passed by each host | Phase 2b |
| S-13 | keep | — | Read-batch range selection | dropped by user (D-9) |
| S-14 | add | — | Shared protocol fixtures asserted by cargo and vitest | applied, Phases 1–2a |

## Mechanical Rules to Enforce

| Rule | Apply at phase | Recipe match | Scaffold command |
|------|---------------|--------------|------------------|
| `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` on `native/projector` | Phase 1 | none (CI step) | added to `.github/workflows/ci.yml` in Phase 1 |
| Pre-push hooks: typecheck, vitest, `cargo fmt --check`, `cargo clippy -D warnings` (D-17) | Phase 1 | none (pre-commit `repo: local`) | `.pre-commit-config.yaml` + `pre-commit install --hook-type pre-push` |
| `child_process` is imported only by `src/main/projection/sidecar.ts` (import/require forms; `*.test.ts` skipped) | Phase 2a | none — vitest guard test scanning `src/` | written in Phase 2a (`src/main/projection/guards.test.ts`) |
| Protocol v1 fixtures parse identically in Rust and TS; `encodeHeader(defaults)` equals `header.valid.json`; `hello.protocol === PROTOCOL` | Phases 1–2a | none | cargo test + vitest over `native/projector/fixtures/protocol-v1/` |
| Type ↔ zod drift (filters typed with `z.custom<FilterNode>`, U-42): `SidecarMessage = z.infer<…>`; `satisfies z.ZodType<…>` on `ProjectionStage`, `CapReason`, `ProjectionStartRequest`, `ProjectionScope`, `PlaceQueryRequest`; `MAX_CELLS` and `NN_DEFAULT` single-sourced (header fixture at the limit) | Phases 1–2a | none — `tsc` + vitest | `scope: a ProjectionScope sample round-trips through scopeSchema`, `protocol: MAX_CELLS matches the Rust cap` |
| "No `any` without a comment" and "`import type` for types" | Phases 2a–4 | **advisory only** — the fork has no ESLint config, so no tool enforces them | reviewed by hand in each phase |

## CI Gate Surface

| Gate | Laid by | At phase |
|------|---------|----------|
| typecheck + vitest + build (TS tree) | upstream `.github/workflows/ci.yml` (job `check`) | already present |
| Rust tree: fmt, clippy -D warnings, cargo test, `cargo llvm-cov --fail-under-lines 70` | Phase 1 (new job `projector`) | Phase 1 |
| TS coverage floor ≥ 70 % on `src/main/projection/**` and `src/renderer/src/features/projection/*.ts` (minus `useProjectionRun.ts`) | Phase 2a (`@vitest/coverage-v8`, `test:coverage` script, CI step) | Phase 2a |
| Local hook runner | Phase 1 (`.pre-commit-config.yaml`, pre-push stage: typecheck, vitest, cargo fmt, clippy; D-17) | Phase 1 |

**Verification at release:** `/loop-implement` Step 10 refuses the final PR until `recipes/ci/gate-inventory/ci_gate_inventory.py`
exits 0 (no core gap); `/plan-validate` refuses READY if this section is missing.

## Failure Modes (resilience)

Trust boundaries crossed: Weaviate network reads · Rust subprocess · renderer → host input (IPC + web HTTP) · host
memory · filesystem (binary path, env override).

| # | Failure mode | Dimension | Required handling | Required test | Phase |
|---|--------------|-----------|-------------------|---------------|-------|
| F-1 | Declared `n` ≠ rows streamed | partial-failure | self-inflicted → design changed: header carries `nMax`; EOF on a row boundary ends the data; `done` echoes actual n; EOF mid-row = error; aggregate count optional | `f_1_eof_before_nmax_completes_with_actual_n`, `f_1_eof_mid_row_is_error`, `F-1: should start a run when the aggregate count throws`, `F-1: should format reading progress without a total` | 1+2b+3 |
| F-2 | Missing / wrong-length / NaN / `default`-keyed vectors misalign uuids and rows | state & data | self-inflicted → design changed (D-15): host validates, skips, counts; uuid and row pushed in one step; multi-vector rejected at start | `F-2: should skip objects with a missing, wrong-length or non-finite vector and count them`, `F-2: should read an unnamed collection's vector from the default key` | 2a |
| F-3 | Filtered read hits the offset wall; partial read presented as done | external I/O | cap at `FILTERED_MAX` (10 000) + banner; a page error fails the run and kills the child; dedupe uuids | `F-3: should reject with the Weaviate message when a filtered page throws`, `F-3: should drop a uuid repeated across offset pages` (2a), `F-3: should fail the run, not finish it, when a filtered page throws` (2b) | 2a+2b |
| F-4 | EPIPE on `child.stdin` crashes the host; drain wait hangs on a dead child | subprocess | error handlers on stdin/stdout/stderr/child; drain raced against close/exit | `F-4: should fail the run and keep the host alive when the child closes stdin mid-stream`, `F-4: should not hang waiting for drain when the child exits`, `F-4: should reject the write, not throw, on EPIPE` | 2a+2b |
| F-5 | A killed run's late events leak into the next run; stale-jobId selection | concurrency | every handler checks its `runId`; read loop checks a cancelled flag per page; selection rejected unless `jobId` is the current, complete dataset; superseded state | `F-5: should ignore a frame and an exit from a killed run after a new run starts`, `F-5: should reject a selection whose jobId is not the current dataset` | 2b |
| F-6 | Child exits without `done` / without `error` | subprocess | terminal state decided at `close`: done+0 → done, else failed with error msg / signal / code / 8 KB stderr tail | `F-6: should fail with the stderr tail when the child exits non-zero without an error line`, `F-6: should fail when the child exits 0 without done`, `F-6: should report the signal when the child is killed` | 2a |
| F-7 | Stalled read or compute hangs | external I/O | per-page read timeout (`pageTimeoutMs` 30 s); 60 s stdout-inactivity watchdog, reset by every host write too (U-43); SIGTERM then SIGKILL after 5 s; Rust emits progress per kNN block group and per frame | `F-7: should kill the child after 60 s without a stdout line`, `U-43: should not trip the watchdog while the host is still writing`, `F-7: should fail when a page read exceeds the timeout` (2a), `F-7: should fail the run and kill the child when a page read rejects` (2b), `f_7_knn_emits_progress_per_block` | 1+2a+2b |
| F-8 | Binary missing / not executable / wrong path | subprocess | pure resolver (env override must be an executable file; `.exe` on win32); checked before any Weaviate read; message names env var, path, build command | three `F-8:` resolver tests (2a) + `F-8: should not read when the binary is unresolvable` (2b) | 2a+2b |
| F-9 | Protocol drift between host and a stale binary | contract | self-inflicted → design changed: first line `hello{protocol}`; mismatch → "rebuild: pnpm projector:build"; `weavit-web.sh` always runs incremental `cargo build` | `F-9: should fail with a rebuild hint when hello.protocol differs`, `f_9_first_line_is_hello_with_protocol_version`, `protocol: fixture hello matches PROTOCOL` | 1+2a+5 |
| F-10 | NDJSON parser faults (split lines, multi-MB lines, garbage, wrong length) | contract | accumulating parser (≤ 64 MB line); bad line or shape → failed "protocol error" and the child is killed on the first one | three `F-10:` tests, `F-10: should kill the child on the first protocol error` | 2a |
| F-11 | Non-finite / collapsed PCA or UMAP coords on duplicate-heavy or rank-deficient sets | state & data | Rust checks `basis`, `pcaChunk`, `pca50` and each frame are finite, else `error` naming the stage (U-38); renderer empty-state when 0 drawable points | `f_11_half_duplicate_rows_produce_finite_umap_coords`, `u_38_pca_is_finite_on_degenerate_input` | 1 |
| F-12 | Stale jobId polled forever | observability | `status` returns terminal `unknown`/`superseded`, never throws; renderer stops polling on terminal state and on error | `F-12: should return a terminal unknown state for an unknown jobId`, `F-12: should stop polling when status errors` | 2b+3 |
| F-13 | Host exit orphans the child | resource | `session.dispose()` on Electron `before-quit` (`index.ts:98`) and web-host SIGINT/SIGTERM (`dispose(); process.exit(0)`); Rust exits 3 on stdout BrokenPipe, and on stdin closed before header | `F-13: should kill the running child when the session is disposed`, `f_13_exits_when_stdin_closes_before_header`, `f_13_broken_pipe_exits_3` | 1+2b |
| F-14 | Unvalidated channel args reach spawn | input | zod schemas for every channel arg (`start`, `status`, `cancel`, `placeQuery`; `filters` a documented shallow `z.array(z.custom<FilterNode>(…))` check, deeper validation left to `buildFilter` (U-42)); validate indices (int, range, unique, ≥ `MIN_SELECTION` 16), dims, limit (1–100 000; 100 001 rejected), n·d, vector name, multi-vector (from config), stale jobId; the sidecar rejects bad headers (exit 2, one fixture per rule); reject before any read or spawn | `F-14: should reject %s before spawning` (table), `channel args: status, cancel and placeQuery are parsed`, `header_rejections_from_fixtures` | 1+2a |
| F-15 | Placement edge cases (no hits in view, zero weights, dim mismatch, basis not ready) | input | explicit `{placed:false, reason}`; unweighted mean fallback; explicit errors | `F-15:` dimension test, `U-12` "0 in view", `overlay: vector input validated` | 2b+4 |
| F-16 | Placement blocks the host event loop | resource | self-inflicted → design changed (D-16): sidecar emits `pca50` once; per query only the query vector is projected | `F-16: should not project the dataset per query` (seam: `createProjectionSession(deps, slot)`; the test empties `slot.dataset.vectors` and placement still answers) | 2b |
| F-17 | Memory: old dataset retained, huge labels | resource | release on replace (dataset **and** the per-runId placement contexts, U-22); text props truncated to `LABEL_MAX_CHARS` 200; points only on request; coords only when `frameVersion > since` | `F-17: should truncate label values to 200 characters` (2a), `F-17: should drop the previous dataset on a new start` (2b, injected `slot`) | 2a+2b |
| F-18 | Empty / tiny sets | state & data | 0 valid rows over the **whole** read (vectorless leading pages do not end it, U-41) → no spawn, terminal `empty`; N < 16 with UMAP → PCA only + notice | `F-18: should finish as empty without spawning when the read returns 0 rows`, `f_18_n_below_neighbors_yields_pca_only`, `f_18_n_equal_neighbors_yields_pca_only` | 1+2b |

Each 🔴/🟡 mode above is a phase acceptance criterion — its handling AND its test ship in the named phase, or the phase is not done.

## Unspecified Behaviors (spec-gap)

Decision points: read scope · distance metric and weights · selection · placement · colour mapping and roles · defaults · lifecycle (cancel, supersede, toggle, tab switch, breadcrumb).

| # | Behavior (was unstated) | Dimension | Decided resolution | Required test | Phase |
|---|-------------------------|-----------|--------------------|---------------|-------|
| U-1 | Filter matching more than the offset limit | scale | D-10: cap at 10 000, report `{read, matched, reason:'offsetLimit'}` (#30) | `U-1: should cap a filtered read at the offset limit and report matched vs read` | 2a |
| U-2 | Basis of a selection run | precedence | D-11: refit on the subset; the basis of the run named by `req.runId` (the level on screen) places queries | `u_2_selection_run_fits_its_own_basis`, `U-2: should place a query with the requested run's basis after drilling down` | 1+2b |
| U-3 | Label/colour properties | defaults | D-12/D-21: Label + Colour are view-only over the prefetched columns; default Label first text prop else uuid; a change recolours/relabels at once (no "Re-run to colour by X") | `U-3: should default the label to the first text property, else uuid`, `U-3: should recolour from the prefetched column without a re-run`, `defaults: array properties are never offered` | 3 |
| U-4 | 2D↔3D / PCA↔UMAP after a run | lifecycle | D-13: PCA 3 cols sliced; UMAP dims change → stale; host keeps the PCA frame next to the UMAP frame | `U-4: should slice the 3-component PCA frame to 2D without a new run`, `U-4: should mark a finished UMAP view stale when dims change` | 2b+3 |
| U-5 | Overlay search scope | scope | search carries the run's tenant, `targetVector` = projected vector (not for bm25), run's filters from `scope.filters`, `includeVector:false`; `queryVector` = `JSON.stringify(vector)` | `U-5: should build the overlay search with the run's tenant, vector and filter`, `overlay: vector and bm25 requests` | 4 |
| U-6 | Status vs open collection | identity | status echoes connectionId/collection/tenant/vector; renderer draws only on match, else "Projection running on X" | `U-6: should not render a frame whose collection/tenant differs from the open view`, `U-6/U-24: status echoes the run inputs` | 2b+3 |
| U-7 | Objects without the vector | optionality | skip + count; banner "97 000 projected · 3 000 without vector" | `U-7: should skip objects without the named vector and count them` | 2a |
| U-8 | Effective cap with large d | boundary | cap = min(limit ≤ 100 000, ⌊100 000·1024/d⌋); reason `dimension` when the d bound binds, `limit` when matched > cap; banner names the cap; limit > 100 000 is rejected (F-14) | `U-8: should compute the effective cap from n and n·d` | 2a |
| U-9 | Tiny sets, pcaDims | boundary | pcaDims = min(50, n−1, D); output columns zero-padded to 3 | `u_9_pca_dims_clamped_and_padded`, `U-9: should not spawn the sidecar for an empty read` | 1+2b |
| U-10 | Centroid weights | representation | bm25/hybrid: score; distance hits depend on the metric (D-19, U-32): cosine max(ε, 1 − d), otherwise (d_max − d) + ε; all ≤ 0 → plain mean with method `mean` | `U-10: should weight nearText hits by 1-distance and bm25 hits by score`, `U-20: should weight l2 hits rank-safely` | 2b |
| U-11 | Query equal to a point | tie | any d = 0 → mean of zero-distance points; rank-k ties → lower row index; the TS-projected query is compared within ε = 1e-4 | `U-11: should place a query at the matching point when its distance is 0` | 2b |
| U-12 | Hits outside the view, k | scope | highlight present hits only; "14 / 20 hits in view"; k default 20 (1–100) | `U-12: centre on present hits only`, `U-12: highlight only hits present in the view` | 2b+4 |
| U-13 | nearObject source is hit #1 | collision | request k+1, drop the source, marker exact on its coords | `U-13: should drop the source object from nearObject hits and mark it exactly` | 4 |
| U-14 | Nested selections | sequencing | indices always root-relative; each level's PCA and UMAP frames kept for instant Back; new root Run clears the breadcrumb | `U-14: should map level-2 lasso indices to root indices` | 4 |
| U-15 | Cancel semantics | lifecycle | keep last frame + dataset, badge "cancelled at …"; partial read kept as partial; cancel after done = no-op | `U-15: should keep the last frame after cancel and report the stage`, `U-15: should show the cancelled badge with the kept stage` | 2b+3 |
| U-16 | Determinism | determinism | fixed seed 42; PCA component sign canonical (largest-|loading| positive); UMAP not promised identical | `u_16_pca_sign_is_canonical` | 1 |
| U-17 | Colour mapping | representation | by schema `dataType[0]`: categorical top 12 (ties by value asc) + other + missing; numeric ramp, missing grey; array properties excluded | `U-17: should bucket top-12 categories, then other, with missing separate` (c01…c11 counts 20…10, k/m tie at 5 → k named, other = {m, z}), `U-17: should ramp numerics with nulls grey` | 3 |
| U-18 | Collection changes after a run | lifecycle | snapshot; no live sync | `U-18: should keep the frame unchanged after a delete from the drawer` | 3 |
| U-19 | Progress text | format | "Reading 37 512 / 100 000" ("Reading 37 512" without a total), "kNN 42 %", "UMAP epoch 90 / 200"; floor %, never 100 % before done | `U-19: should format progress per stage and never show 100% before done` | 3 |
| U-20 | Distance metric of the collection | representation | D-19: cosine → host L2-normalises rows (zero vector skipped, counted `zeroNorm`) and query vectors; dot/hamming → raw + notice "dot metric: Euclidean layout"; l2-squared → raw; hit weights per metric (U-32) | `U-20: should L2-normalise rows for a cosine metric` (rows [1,0], [100,1], [0,1] → unit norm, NN of row 0 = row 1), `U-20: should stream raw rows for l2-squared and dot`, `U-20: should skip a zero vector under cosine`, `U-20: should weight l2 hits rank-safely` (d = [4,16] → weights [12+ε, ε]), `U-20: should normalise a cosine query before placement`, `U-20: should add the Euclidean-layout notice for dot` | 2a+2b |
| U-21 | Which placements are approximate | representation | `approximate = true` except a vector query in the PCA view and the `object` kind; badge "approximate (15-NN)" (built from `NN_DEFAULT`) / "approximate (hit centroid)" / "approximate (unweighted mean of hits)" | `U-21: approximate per view and kind` (`{view:'umap',kind:'vector'}` → true; `{view:'pca',kind:'vector'}` → false), `U-21: should badge approximate placements` | 2b+4 |
| U-22 | Back in the breadcrumb vs placement and drawing | identity | Back is bound to a runId; renderer draws only when `status.runId` = the level's runId; host keeps a placement context (basis, pca50, coords) per runId of the current dataset, honours `req.runId`, unknown runId → `{placed:false, reason:'run not available'}`; each level stores its PCA and UMAP frames | `U-22: should place in level 1's basis after a level-2 selection`, `U-22: should refuse an unknown runId`, `U-22: should not draw a status from another level`, `U-22: should keep both frames per level for Back` | 2b+4 |
| U-23 | When the overlay is re-placed | lifecycle | re-call `placeQuery` on each new frame epoch, on PCA↔UMAP and on a dims change (react-query key `placementKey`) | `U-23: should re-place the overlay on a new frame epoch, view or dims` | 4 |
| U-24 | Controls after a tab switch | lifecycle | `status.scope` echoes filters, method, dims, limit, props, dim (+ metric); run inputs restored from `scope`, else "edited — Run to apply"; Label/Colour live in the slice; the overlay uses the run's filters; `scopeSchema` guards drift | `U-6/U-24: status echoes the run inputs`, `U-24: a selection's scope keeps the root filters`, `U-24: should restore the controls from the run scope`, `scope: a ProjectionScope sample round-trips through scopeSchema` | 2a+2b+3 |
| U-25 | Colour vs Label roles | defaults | D-12: props [title:text, category:text] → colour category, label title; tooltip shows both | `U-25: should assign Colour and Label roles from the schema` | 3 |
| U-26 | Colours in a drill-down | representation | levels inherit the root's category → colour map; categories absent from it → "other" | `U-26: should inherit the root's category colours in a drill-down` | 4 |
| U-27 | Breadcrumb lifecycle | lifecycle | push a level when its run starts (marked failed/cancelled if it ends so); Back during an in-flight child cancels it and pops; re-run replaces the level with the same indices; a selection run uses the current dims control | four `U-27:` tests (push + fail mark, Back cancels, re-run replaces, current dims) | 4 |
| U-28 | Which vector length is D | boundary | D from the caller when known (selection: dataset D; Weaviate config carries no dimension), else the **modal** length on the first page that holds vectors (U-41), never the first valid row | `U-28: should fix D from the modal length on page 1` ([len 128, then 999 × len 384] → D 384, `skipped.dim` 1), `session: spawns after page 1 with nMax = cap and dim = D` | 2a+2b |
| U-29 | Order basis of a capped read | format | D-8/D-10: banner "first 100 000 in server order (UUID cursor)" / "first 10 000 in server order (server limit)" | `U-29: should state the order basis in the cap banner` | 3 |
| U-30 | Selecting after a cancelled read | lifecycle | `status.readComplete` false → `canSelect` false, hint "read was cancelled — Run again to select" (never inferred from `stage`); the host also rejects such a selection | `U-30: should block selection after a cancelled read`, `U-30: should reject a selection after a cancelled read`, `status: n and readComplete mid-read` | 2b+4 |
| U-31 | Control defaults | defaults | method UMAP, dims 2, limit 100 000, vector = the first non-multi-vector named vector in config order | `U-31: should default to UMAP, 2D and the first single-vector space` ([colbert(multi), title_vec, body_vec] → title_vec, umap, 2) | 3 |
| U-32 | Weights for signed distances (dot) | representation | every non-cosine metric uses w = (d_max − d) + ε (rank-safe, > 0); cosine max(ε, 1 − d); scores unchanged; the all-≤-0 fallback is method `mean`, badge "unweighted mean of hits", never "hit centroid" | `U-32: should give positive, ordered weights to negative dot distances` (d = [−10, −2] → w₀ > w₁ > 0, marker between them), `U-32: should stay finite near zero` (d = [−1e-7, −5]) | 2b+4 |
| U-33 | Index inside a selection | identity | each context's `uuidIndex` = `uuids[indices[i]] → i` over the root uuids; `points.uuids` of a selection = its subset in view order, `indices` = root indices; a uuid outside → not highlighted, object query → `{placed:false, reason:'point not in this selection'}` | `U-33: should index a selection's points locally` (indices [10,20,30], hit row 20 → local 1, inView 1), `U-33: should refuse an object outside the selection` (row 5), `U-33: should highlight a selection's local index only` | 2b+4 |
| U-34 | Run while below the root | lifecycle | D-20: method/dims only → `rerunLevel(current)`; filter/limit/vector/tenant edited → confirm "this clears the breadcrumb (N levels)"; accept → [All] + root start; decline → nothing sent | `U-34: should re-run the level when only dims changed`, `U-34: should confirm before a root re-run from below the root` | 4 |
| U-35 | Colour change below the root | lifecycle | D-21: recolour from the prefetched column, no start call | `U-35: should recolour at level 1 without a run` | 4 |
| U-36 | Numeric ramp in a drill-down | representation | the level inherits the root's {min, max} | `U-36: should keep root numeric colours in a drill-down` (root year [1990, 2020], level 2000–2010 → 2000 same colour) | 4 |
| U-37 | Manhattan / unknown metric | representation | raw rows + notice "<metric> metric: Euclidean layout", weights per U-32; `VectorMetric` keeps unknown strings; never a silent cosine (absent distance = Weaviate's documented cosine default) | `U-37: should stream raw rows for manhattan and unknown metrics`, `U-37: should add the Euclidean-layout notice for manhattan` | 2a+2b |
| U-38 | Rank-deficient PCA input | boundary | `k = min(p + 10, nFit, D)`; a Gram-Schmidt column or component with norm < 1e-12 becomes a zero component (never divided); `basis`/`pcaChunk`/`pca50` checked finite, else `error` naming "pca"; expected values fixed (`pca_recovers_known_axes`: pcaDims 20; `u_9`: k 3) | `u_38_pca_is_finite_on_degenerate_input` (n=20 D=384 · n=1 · 50 identical rows → all finite) | 1 |
| U-39 | Whose points a status returns | identity | `ProjectionStatusOptions.runId`: root → dataset rows, selection → its subset by indices; `points.runId` echoed; renderer drops a mismatched reply; points queries `gcTime: Infinity`; root colour maps from the root run's columns | `U-39: should answer points for the requested level` (L1 → L2 → `{points, runId:L1}` → N uuids), `U-39: should drop points from another run`, `U-39: should build root colour maps from the root run's points` | 2a+2b+3+4 |
| U-40 | Cap reason and filtered count | boundary | `capReason` kept only when the final n === cap; `count()` passes the read's filters to `overAll` | `U-40: should drop the cap reason when the read ends below the cap` (filtered, count throws, 500 rows → no cap), `U-40: should pass the filters to the count` | 2a+2b |
| U-41 | Leading pages without vectors | boundary | read on until the first page with a vector fixes D; `empty` only after the whole read | `U-41: should fix D on the first page that has vectors` (page 1 = 1 000 vectorless, page 2 = 1 000 valid → n 1 000, `skipped.missing` 1 000) | 2a+2b |
| U-42 | Typing the `filters` schema | contract | `z.array(z.custom<FilterNode>(v => typeof v === 'object' && v !== null))` — `z.array(z.unknown())` fails `satisfies z.ZodType<…>` (TS1360, zod 3.25.76) | `U-42: startRequestSchema satisfies the request type` | 2a |
| U-43 | Watchdog during a slow read | lifecycle | every host write resets the 60 s silence watchdog; after `end()` only stdout resets it | `U-43: should not trip the watchdog while the host is still writing` (10 pages × 7 s → not killed) | 2a |
| U-44 | `since` across runs | identity | `since` is keyed by runId: `sinceFor(prevRunId, runId, v)` → −1 on a new runId | `U-44: should restart since at -1 on a new run` | 3 |
| U-45 | Partial PCA frame | representation | `toStatus` encodes only the PCA rows covered so far (absent at 0); renderer counts `coords.length / 3` | `U-45: should send only the PCA rows covered so far` (9 000 rows before the fit → no `pca`), `U-45: should count PCA points from the payload length` | 2b+3 |
| U-46 | Two starts racing | concurrency | runId + generation taken synchronously in `start`; a start stale after `await getConfig` is dropped | `U-46: should keep the newer of two racing starts` (resolutions reversed → slot holds the second) | 2b |
| U-47 | No single-vector space | defaults | `vector` undefined, Run disabled with "no single-vector space (#32)" | `U-47: should disable Run without a single-vector space` ([colbert] → `canRun` false) | 3 |
| U-48 | Multi-vector behind a dynamic index | input | detection also checks `indexConfig.hnsw?.multiVector` | `U-48: should flag a multi-vector space behind a dynamic index` | 2a |
| U-49 | Degenerate numeric colour column | boundary | all-null or constant → a single colour, no division by zero | `U-49: should give a constant or all-null numeric column a single colour` (int [5,5,null] → finite) | 3 |
| U-50 | Skipped-rows banner | format | every non-zero count listed (missing, dim, nonFinite, zeroNorm) | `U-50: should list every non-zero skipped count` (→ "3 wrong length, 2 zero norm") | 3 |
| U-51 | Points after a cancelled or failed run | lifecycle | a **cancelled** read keeps its partial dataset and serves points for the rows read; a **compute-stage** failure (read complete) keeps the dataset and its points; a **failed read** (page error, or the child dying mid-read) drops the dataset: state `failed`, no points, and the renderer never requests them (`pointsEnabled` = `readComplete` or `cancelled`) | `U-51: should serve points for a cancelled read`, `U-51: should fetch points on any terminal state`, `U-51: should return the partial result of a cancelled read`, `U-51: should drop the dataset when the read fails` | 2b+3 |
| U-52 | Progress text for every stage | format | "PCA {done} / {total} rows" (Rust pca units: rows projected / rows received), "Building graph", plus the existing reading/kNN/epoch texts | `u_52_pca_progress_counts_rows`, `U-52: should format every stage` | 1+3 |
| U-53 | PCA stride and marker dims | representation | the PCA frame is always stride 3; `placeExactPca` returns 3 coordinates; the renderer slices both for 2D | `U-53: placeExactPca always returns 3 coordinates`, `U-53: should slice the 3-coordinate PCA marker for 2D` | 2b+3 |
| U-54 | Testable Run / Colour decisions | lifecycle | pure `resolveRun(action, confirmed, ctx) → {request | null, levels}` and `onColourChange(state, prop) → {start: null}` carry the U-34/U-35 oracles in node-env tests (no testing-library) | `U-34: should confirm before a root re-run from below the root`, `U-35: should recolour at level 1 without a run` | 4 |

Each behavior above is a phase acceptance criterion — its handling AND its test ship in the named phase, or the phase is not done. No assumption is left `(unknown — user to confirm)`.
