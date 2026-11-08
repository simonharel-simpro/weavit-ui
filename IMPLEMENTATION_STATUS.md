# Implementation Status — Weavit UI embedding projector

**Plan:** `IMPLEMENTATION_PLAN.md` (+ `IMPLEMENTATION_PLAN_PHASE_{1,2a,2b,3,4,5}.md`) · **Integration branch:** `feat/embedding-projector` → `main`

| Phase | Title | Status | Branch |
|-------|-------|--------|--------|
| 1 | Rust sidecar `weavit-projector` + Rust CI job + pre-commit | ✅ landed @ 2ae261e (/check clean, fix-check 1 iter) | `phase-1-rust-sidecar` |
| 2a | Host core: shared contracts, protocol, sidecar, read, validate (+ Phase 0 fork hygiene) | ✅ landed @ 9c8e70b (/check clean after Phase 0) | `phase-2a-host-core` |
| 2b | Host session, run state, placement, channels, hosts wiring | ✅ landed @ bdd806c (/check clean, fix-check 1 iter) | `phase-2b-host-session` |
| 3 | Renderer: Projection tab (deck.gl 2D/3D, controls, colour, progress) | ⏳ pending | — |
| 4 | Selection (lasso, breadcrumb) + query overlay | ⏳ pending | — |
| 5 | data-lab: ADRs, ARCHITECTURE.md, launcher, submodule bump | ⏳ after the fork PR merges (other repo) | — |

## Phase 1 — Rust sidecar + Rust CI + pre-commit
**Implemented:** 2026-11-07 · **Agent:** rust-cli · **Tooling (agent):** fmt, clippy -D warnings, cargo test 49 passed, llvm-cov 97.75 % (floor 70), pre-commit pre-push green · bench 100k×384 UMAP 3D in 22 s
- New: `native/projector/` (protocol v1, input, pca + Jacobi, exact kNN, umap_run, stream), 23 protocol fixtures, tests; `.pre-commit-config.yaml`; CI job `projector`.
- Escalation ESC-1-1 (reversible): `repulsion_strength = 0.5` compensates umap-rs 0.4.5 halving attraction.
- Local note: pnpm 11 on this machine needs `pnpm_config_verify_deps_before_run=false` (`pnpm-workspace.yaml` `allowBuilds` placeholders); CI uses pnpm 9.

## Phase 2a — Host core
**Implemented:** 2026-11-07 · **Agent:** general-purpose · **Tooling (agent):** typecheck 0, vitest 425 passed, coverage lines 99.35 % (floor 70), pre-commit green
- New: `src/shared/projection.ts`, `src/main/projection/{protocol,binary,sidecar,validate,readVectors}.ts` + tests, `guards.test.ts`.
- Modified: `shared/{types,channels,api}.ts`, `weaviate/collections.ts` (multiVector/distance), vitest coverage, CI `test:coverage`, `@vitest/coverage-v8@5.0.5`.
- Deviations (IMPLEMENTATION_NOTES.md): lazy `onStart`; a cap cut mid-page counts as truncated; filtered reads stop at offset 10 000; sidecar outcome precedence.

## Phase 0 — Fork hygiene (done on phase-2a-host-core, user decision 2026-11-07)
- Electron 37 → 43.8.3, electron-builder 25 → 26.18.0, zod 3 → 4.6.7; ESLint 10 flat config (+ hook + CI step); 16 range overrides in both `pnpm-workspace.yaml` and `package.json#pnpm`; `packages: ['.']` repairs the pnpm 9 CI install.
- `pnpm audit --audit-level=moderate` exit 0 (GHSA-g3hv-75wg-m249 / GHSA-3g3m-2fjr-6pw4 ignored until #34). typecheck, lint, 425 tests, build, web:build, pack:dir, pnpm 9 frozen install all pass.
- Pending: GUI smoke of Electron 43 on a native display.

## Phase 2b — Host session, run state, placement, wiring
**Implemented:** 2026-11-08 · **Agent:** general-purpose · **Tooling (agent):** typecheck 0, lint 0 errors, vitest 482 passed (lines 97 %), pre-commit green; live web-host run on MiniRag (41 pts): read → done, selection → done, unknown jobId → unknown, no orphan sidecar after SIGTERM
- New: `projection/{place,state,run,source,session,drive}.ts` + tests, `ipc/registry.test.ts`; wiring in `ipc/registry.ts`, `ipc/electron.ts`, `main/index.ts`, `web/main.ts`; `encodeF32` in protocol.
- Deviations (IMPLEMENTATION_NOTES.md): `drive.ts` split; contracts added (`encodeF32`, `Run.n`); cancel drops the in-flight page; supersede on commit only; placement edge weights.
