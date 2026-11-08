# Implementation notes (Phase 1, deviations from the plan)

## umap-rs 0.4.5 smears clusters at its default repulsion
- Plan assumed: `UmapConfig::default()` plus the plan's parameters yields clean cluster separation (test `umap_separates_clusters`: intra < 0.5 x inter).
- Territory was: with the defaults the planned test fails (intra 7.8 vs inter 10.6, kNN purity of the embedding 0.64 on 3 clean blobs). `Optimizer::step_epochs` applies the "move other" half of every attraction step to a per-call copy of the embedding that is dropped, so attraction is half of umap-learn's while repulsion is full. The library's own `Umap::fit` with random init shows the same smearing.
- I did: set `repulsion_strength = 0.5` (`REPULSION_STRENGTH` in `src/umap_run.rs`), the value that restores the attraction/repulsion balance (not tuned to pass; 1.0 -> ratio 0.73, 0.5 -> 0.26, 0.25 -> 0.07). The test is unchanged. A planner may prefer a different value or another UMAP crate.
- One-off or pattern?: likely recurs - candidate for a note on any code that drives umap-rs `Optimizer` directly.

## pnpm 11 refuses to run scripts in this worktree
- Plan assumed: `pnpm projector:build` and the `pnpm typecheck` / `pnpm test` hooks run after `pnpm install --frozen-lockfile`.
- Territory was: pnpm 11 re-runs `pnpm install` before every script (deps-status check) and fails with `ERR_PNPM_IGNORED_BUILDS` (electron, protobufjs; `pnpm-workspace.yaml` has unset `allowBuilds`). CI pins pnpm 9, which does not do this.
- I did: ran every pnpm command with `pnpm_config_verify_deps_before_run=false`; changed no project file. Developers on pnpm 10+/11 need the same or to resolve `allowBuilds`.
- One-off or pattern?: one-off

## Escalations
- ESCALATION(ESC-1-1) [open] phase=1 tier=reversible :: UMAP repulsion_strength=0.5 to compensate umap-rs 0.4.5 halving attraction (move-other lost in step_epochs); confirm the value or switch crate

## Gate-gap fixes (cargo xtask lint, cargo deny)
- Deviation: installed the linters recipe `xtask/` + `.cargo/config.toml` only; no githooks/justfile (repo uses pre-commit). Hook `cargo-xtask-lint` added (pre-push) and a `cargo xtask lint` step in the CI `projector` job. The root manifest is now a workspace (members `.` and `xtask`); root stays the default member, so `cargo build --release` and the binary path are unchanged.
- Deviation: `cargo deny check` is NOT in pre-commit or CI (not requested); it passes locally with `native/projector/deny.toml`.
- Added `license = "Apache-2.0"` to the crate and to xtask (xtask is std-only, no new runtime dependency).
- deny.toml allow-list: MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2/3-Clause, Unicode-3.0. `cargo deny list` also shows LGPL-2.1-or-later (r-efi, Windows/UEFI-only transitive dep of getrandom, tri-licensed MIT OR Apache-2.0 OR LGPL) and Unlicense (memchr, Unlicense OR MIT). Neither is allowed; both are satisfied via their MIT option. No copyleft was allowed.
- `cargo xtask lint` reported no violations in the crate's own code; nothing was loosened.

# Phase 2a deviations

## A filtered read never pages past the server offset limit
- Plan assumed: a filtered read stops at `cap` (≤ `FILTERED_MAX`); offset paging is otherwise unbounded.
- Territory was: when rows are skipped (vectorless, wrong length, duplicates), `n` is still below `cap` at offset 10 000, and the next page (`offset + limit > 10 000`) makes Weaviate fail the whole read with "query maximum results exceeded".
- I did: `readVectors` requests `limit = min(PAGE_SIZE, FILTERED_MAX - offset)` and stops at offset 10 000, returning the rows read. Per U-40, a read that ends below its cap reports no `capReason`, even though the offset limit is what bound it; `cap.matched` vs `read` still shows the gap. Test: "never pages a filtered read past the server offset limit".
- One-off or pattern?: likely recurs: any offset-paged Weaviate read near QUERY_MAXIMUM_RESULTS.

## onStart waits for the first valid row, not just the first page with vectors
- Plan assumed: D is fixed on the first page that holds any vector, then `onStart` is called, and the read is `empty` (no `onStart`) only when the whole read has no valid row.
- Territory was: these two rules conflict when the first vector page has no *valid* row (e.g. every row is zero-norm under cosine or non-finite).
- I did: D (and the cap and buffer) is still fixed on that first vector page, but `onStart` is called lazily, right before the first `onPage`. A read with no valid row never spawns. U-41 is unchanged (`onStart` once, after page 2).
- One-off or pattern?: one-off

## "Full last page" for the cap reason includes a page cut mid-way by the cap
- Plan assumed: when `n === cap` with no reason yet, `'limit'` applies on "a full last page".
- Territory was: the cap can be reached partway through a short page that still holds unread objects. More data exists, but the page is not full.
- I did: `truncated = consumed < page objects || page.length === requested limit`, then `'limit'` applies only when `matched` is unknown or `matched > n` (U-40 unchanged).
- One-off or pattern?: one-off

## Sidecar outcome precedence
- Plan assumed: done + 0 → ok; else the `error` message, "killed by SIGKILL", or "exited with code N" + tail; a ProtocolError → "protocol error: …"; the watchdog → "no output for 60 s".
- Territory was: the plan does not order a host kill reason (watchdog, or `kill(reason)` from the session) against the child's `error` message or the signal.
- I did: protocol or hello failure > done + exit 0 > host kill reason > child `error` message > signal (+ stderr tail) > exit code (+ stderr tail). The stderr tail is also appended to the signal case. `ProtocolError` text does not echo the offending stdout line, so no payload reaches logs.
- One-off or pattern?: one-off

# Phase 0 deviations

## The committed lockfile already failed the 14-day age rule
- Plan assumed: if `minimumReleaseAgeStrict` blocks a package, pin its parent one patch lower.
- Territory was: pnpm 11 checks the existing lockfile against the policy before it resolves anything. It rejected 20 transitive entries left by the Vite 8 upgrade (rolldown 1.2.16 and its 15 `@rolldown/binding-*`, `@oxc-project/types` 0.156.0, postcss 8.5.32, magic-string 1.4.5, tinybench 6.2.3, all published 2026-10-26 to 11-01). Their parents (vite 8.3.5, vitest 5.0.5, electron-vite 6.0.0) are old enough, and their ranges already accept older versions.
- I did: no parent was pinned. I ran one `pnpm install --lockfile-only` with temporary overrides (rolldown 1.2.15, @oxc-project/types 0.155.0, postcss 8.5.31, magic-string 1.4.3, tinybench 6.2.2, all ≤ 2026-10-21), then removed them before the real install. The direct `postcss` moved from 8.5.25 to 8.5.31 within `^8.4.49`, so vite and the app now share one copy. With strict mode on, the final lockfile passes the policy check.
- One-off or pattern?: likely recurs: any lockfile committed before `minimumReleaseAge` was turned on.

## eslint-plugin-react-hooks 7 pulled in a second zod
- Plan assumed: `pnpm why zod` shows only 4.6.7 once zod is pinned.
- Territory was: eslint-plugin-react-hooks 7.1.1 and zod-validation-error accept `^3.25.0 || ^4.0.0`, and pnpm reused the zod 3.25.76 that was already locked.
- I did: ran `pnpm dedupe`. Its only other change was picomatch 4.0.5 → 4.0.7 (2026-08-24) under tinyglobby.
- One-off or pattern?: one-off

## One `any` had no disable directive
- Plan assumed: every file that uses `any` already carries the disable directive, and `no-explicit-any` stays error.
- Territory was: `src/main/weaviate/filters.test.ts:38` (`Record<string, any>` in a fake of the client's filter namespace) had none. It is not dead code, so the "≤ 3 hits → delete dead code" rule did not apply.
- I did: added one `eslint-disable-next-line @typescript-eslint/no-explicit-any` with a reason, matching the convention the other files use. The rule stays error, and the source total is 3 lines (budget 50).
- One-off or pattern?: one-off

## The glob GHSA no longer applies
- Plan assumed: both GHSA-g3hv-75wg-m249 (minimatch) and GHSA-3g3m-2fjr-6pw4 (glob) remain after the upgrade.
- Territory was: with electron-builder 26 the tree has only glob 7.2.3, which is outside `>=9 <=14.0.1`. With the ignores removed, the audit shows only the minimatch advisory (via app-builder-lib and @electron/universal). The summary reads "1 moderate (1 ignored)".
- I did: kept both IDs in `ignoreGhsas` as specified (the glob entry has no effect). The override map has 16 selectors: the table's rows expand to 16, not the 15 stated. A new `allowBuilds` placeholder, `electron-winstaller`, was set to `false`; it is Windows-installer only, and `pack:dir` passes without it.
- One-off or pattern?: one-off

# Phase 2b deviations

## session.ts would be 272 lines; the run driver moved to drive.ts
- Plan assumed: `session.ts` (≤ 200 lines) holds the slot, the read/selection streaming and the event routing.
- Territory was: with the read loop, the selection writer, the sidecar wiring and start ordering, the file came to 272 lines.
- I did: `drive.ts` (141) owns `launch`/`read`/`select`, the sidecar wiring and the per-run event guards; `session.ts` (161) keeps the deps, validation, U-46 ordering, status/cancel/placeQuery/dispose and `createDefaultProjectionSession`. Public API unchanged.
- One-off or pattern?: one-off

## Contracts the spec used but Phase 2a did not ship
- Plan assumed: an f32 encoder for `status.pca`/`umap` and the stdin rows, a `n` field on `Run`, and the session knowing whether the read is filtered.
- Territory was: only `decodeF32` existed; the `Run` interface has no `n` although the transition table writes it; `buildFilter` can return nothing for a non-empty `filters` list.
- I did: added `encodeF32` + `f32Bytes` (a zero-copy view on little-endian hosts, a `writeFloatLE` loop otherwise) to `protocol.ts`; added `n` to `Run`; `collectionSource` also returns `filtered` (whether a filter was actually built) and omits `returnProperties` when there is no colourable prop. `scope.dim` is 0 until the first vector page fixes D.
- One-off or pattern?: one-off

## A cancel drops the page in flight
- Plan assumed: `isCancelled` is read between pages, so a cancelled read resolves with the rows read so far (U-51).
- Territory was: a page fetched while the cancel lands would still be ingested (rows never streamed) or, if it rejects, or if the cancel's kill breaks a pending `sidecar.write`, `readVectors` rejects and the partial dataset is lost.
- I did: the session wraps the source so a page that resolves or rejects after a cancel reads as `[]` (end of read), and a write rejected after a cancel is not an error. Tests: "U-51: should serve points for a cancelled read" (page 3 resolves after the cancel, 2 000 points) and "…when a cancel interrupts a pending write".
- One-off or pattern?: likely recurs: any cancel of a paged read that streams into a child.

## Start ordering details
- Plan assumed: a new start kills the running child; F-8 rejects before any object read.
- Territory was: the plan does not say whether a start that later fails validation (or loses the U-46 race) has already killed the running run.
- I did: the old run is superseded and killed only when the new start commits (after validation, binary resolution and the generation check), so a rejected start leaves a healthy run alone. The binary is resolved right after the request parse, before `getConfig`, so F-8 rejects without any network call. A selection while the read is still running is told "still being read"; one on a cancelled read gets the U-30 text even before the partial dataset has landed.
- One-off or pattern?: one-off

## Placement edge cases the plan leaves open
- Plan assumed: hit weights are `score`, `max(ε, 1 − d)` or `(d_max − d) + ε`; all ≤ 0 → plain mean.
- Territory was: a hit can lack the field it is ranked by, scores can be negative next to positive ones, and a zero query vector has no cosine direction.
- I did: a hit missing its field weighs 0; a negative score weighs 0 (`max(0, score)`, so the marker stays inside the hull; all zero → `mean` as specified); a zero vector under cosine → `{placed:false, reason:'a zero vector has no cosine direction'}`. `deps.now` only times the run in the terminal log line; the 60 s watchdog stays on the sidecar's own timers.
- One-off or pattern?: one-off

# Phase 3 deviations

## The pinned @loaders.gl/core 4.4.5 does not satisfy a transitive peer
- Plan assumed: pinning `@loaders.gl/core@4.4.5` (deck.gl asks `^4.4.3`) leaves no peer issue.
- Territory was: `@deck.gl/layers` resolves `@loaders.gl/images@4.5.4`, which peers `@loaders.gl/core ~4.5.0`; `pnpm peers check` reports it unmet. Install, both builds and the pnpm 9 frozen install pass. Only the image loaders (Bitmap/Icon layers, unused here) could be affected.
- I did: kept the planned pins. A planner may prefer `@loaders.gl/core@4.5.4`, if it clears the 14-day rule.
- One-off or pattern?: likely recurs: any exact-pin plan for a package family whose transitive deps float.

## Coverage glob and lazy tab
- Plan assumed: only `useProjectionRun.ts` is React glue excluded from coverage; the tab is imported directly.
- Territory was: a second hook, `useProjectionView.ts`, holds the decode and colour memoisation; deck.gl is ~660 kB, most of the bundle.
- I did: `vitest.config.ts` excludes `projection/use*.ts`; `ProjectionPanel` is `React.lazy` in `CollectionView.tsx`. Extra files beyond the plan's eight: camera.ts (pure, tested), ProjectionTooltip, ProjectionLegend, ProjectionStatusLine, ProjectionObjectDrawer, useProjectionView, lib/query-keys.ts, status.fixtures.ts.
- One-off or pattern?: one-off

# Phase 4 deviations

## resolveRun, hitsForPlacement and the Stage: signatures the spec could not satisfy
- Plan assumed: `resolveRun(action, confirmed, {jobId, levels, controls, scope})`; `hitsForPlacement(results, mode, sourceUuid?)` also covers a vector query; only `ProjectionCanvas` is untouched and no other Phase 3 file changes.
- Territory was: before the first run there is no `scope` to read the collection/tenant from; a vector query's marker needs the vector, which is not in the results; `ProjectionStage` (the Phase 3 wrapper) forwarded none of `highlight`/`marker`/`onViewportChange`/`tooltipActions`; the hit uuids to highlight are a second output of the same function.
- I did: `ctx` carries `view` (connectionId/collection/tenant) instead of `scope`; `hitsForPlacement` takes a 4th `vector` argument and a sibling `hitUuidsOf` returns the uuids to highlight (source dropped for a point query); `ProjectionStage` gained passthrough props and a children slot; `useProjectionRun`/`useProjectionView` take the level on screen (the polled run differs from it after Back) and the frames as input.
- One-off or pattern?: likely recurs: a pure-helper spec written before the call site exists.

## A re-run keeps the old level until the new runId is known
- Plan assumed: `resolveRun` returns the level already replaced for `rerunLevel`.
- Territory was: the new runId only exists once `start` resolves; marking the level running under its old runId made the settle effect re-settle it from the old, terminal status.
- I did: `resolveRun` returns the levels unchanged for a re-run; `rerunLevel(levels, index, runId, dims?)` replaces the level in `onSuccess`. A failed start leaves the level as it was.
- One-off or pattern?: one-off

## canSelect on a failed or incomplete read; stored levels
- Plan assumed: `canSelect` is false only for a cancelled incomplete read or a run in flight, otherwise true.
- Territory was: a `failed`/`empty` run with `readComplete` false would be offered a selection the host rejects; after Back the status polled is the popped child's, so the level on screen has no live status.
- I did: any not-in-flight run with `readComplete` false is blocked (generic hint; the cancelled hint is unchanged). `canSelectLevel(status, level)` uses the live status when it owns the level, else the stored level outcome (`done` only).
- One-off or pattern?: one-off

## Back keeps the polled run; the level on screen is the breadcrumb top
- Plan assumed: Back shows the stored frame (U-14).
- Territory was: the host only serves the latest run's status, so after Back the polled status belongs to the popped child.
- I did: the store's `jobId`/`runId` stay the latest run; the points query and frames follow the breadcrumb top (`framesToDraw`: live frames when the status owns the level, else the level's stored `pcaFrame`/`umapFrame`). A level also stores `n`, and an unmatched collection/tenant clears the breadcrumb in `useBreadcrumbSync`. "Use as query" runs the search at once instead of only arming it.
- One-off or pattern?: likely recurs: any drill-down over a single-slot host.
