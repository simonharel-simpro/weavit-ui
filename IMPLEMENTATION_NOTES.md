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

