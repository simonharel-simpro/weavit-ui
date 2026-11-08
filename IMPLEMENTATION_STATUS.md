# Implementation Status — Weavit UI embedding projector

**Plan:** `IMPLEMENTATION_PLAN.md` (+ `IMPLEMENTATION_PLAN_PHASE_{1,2a,2b,3,4,5}.md`) · **Integration branch:** `feat/embedding-projector` → `main`

| Phase | Title | Status | Branch |
|-------|-------|--------|--------|
| 1 | Rust sidecar `weavit-projector` + Rust CI job + pre-commit | ✅ landed @ 2ae261e (/check clean, fix-check 1 iter) | `phase-1-rust-sidecar` |
| 2a | Host core: shared contracts, protocol, sidecar, read, validate | ⏳ pending | — |
| 2b | Host session, run state, placement, channels, hosts wiring | ⏳ pending | — |
| 3 | Renderer: Projection tab (deck.gl 2D/3D, controls, colour, progress) | ⏳ pending | — |
| 4 | Selection (lasso, breadcrumb) + query overlay | ⏳ pending | — |
| 5 | data-lab: ADRs, ARCHITECTURE.md, launcher, submodule bump | ⏳ after the fork PR merges (other repo) | — |

## Phase 1 — Rust sidecar + Rust CI + pre-commit
**Implemented:** 2026-11-07 · **Agent:** rust-cli · **Tooling (agent):** fmt, clippy -D warnings, cargo test 49 passed, llvm-cov 97.75 % (floor 70), pre-commit pre-push green · bench 100k×384 UMAP 3D in 22 s
- New: `native/projector/` (protocol v1, input, pca + Jacobi, exact kNN, umap_run, stream), 23 protocol fixtures, tests; `.pre-commit-config.yaml`; CI job `projector`.
- Escalation ESC-1-1 (reversible): `repulsion_strength = 0.5` compensates umap-rs 0.4.5 halving attraction.
- Local note: pnpm 11 on this machine needs `pnpm_config_verify_deps_before_run=false` (`pnpm-workspace.yaml` `allowBuilds` placeholders); CI uses pnpm 9.
