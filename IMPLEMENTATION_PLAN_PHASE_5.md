# Phase 5 — data-lab: ADRs, ARCHITECTURE.md, Weavit launcher builds the binary, submodule bump

**Depends on:** Phases 1, 2a, 2b, 3 and 4 merged on the fork's `feat/embedding-projector` (pushed to `simonharel-simpro/weavit-ui`).
**Repo:** data-lab, `/home/simon/projects/data-science/data-lab`, new branch `feat/weavit-projector` from `main`.
**Agent:** `general-purpose` for every file (the docs and the shell script).

## Files

#### `tools/weavit-web.sh` (MODIFY) — agent `general-purpose`
The script already `cd`s into `tools/weavit-ui` (`weavit-web.sh:16`), so after the `web:build` block (`:19-21`) and
before starting the server, always run `pnpm_ run projector:build` (the Phase 1 script: `cargo build --release
--manifest-path native/projector/Cargo.toml`, relative to the submodule). It is incremental: a no-op when up to date, a
rebuild when the sources changed (F-9: never keep a stale binary). If `command -v cargo` fails, print one line ("cargo
not found: the Projection tab will say the binary is missing") and continue. **A compile failure is non-fatal:** print
"projector build failed (see the cargo output above): the Projection tab will say the binary is missing" to stderr and
continue serving — the rest of Weavit works without it. Keep the existing `web:build` condition as it is (`weavit-web.sh:19`).
`--rebuild` now also runs `pnpm_ install --frozen-lockfile` before `web:build` (today install only runs when
`node_modules` is absent, `weavit-web.sh:18`; the deck.gl and luma.gl packages from Phase 3 would otherwise be missing
after a submodule update).

#### `decisions.md` (MODIFY)
Append, dated on the merge day:
1. **Embedding projector: a Rust sidecar in the Weavit fork** — context (100k target, measured umap-js / umap-learn /
   Rust numbers), decision (D-1, D-2, D-3, D-16: sidecar spawned by the host, exact kNN on PCA-50, umap-rs), alternatives
   (umap-js in a worker, umap-learn service, HNSW, napi addon, WASM), consequences (Rust toolchain needed to build;
   the fork drifts further from upstream; installers don't ship the binary yet, #29; **host memory**: up to ~400 MB of
   vectors held in the host in the worst case (100 000 × 1024 f32), plus a second copy of the 100k × p PCA coords in
   the placement context of each breadcrumb level; plus the prefetched colour/label columns (D-21): every text, boolean,
   int and number property, text capped at 200 chars — worst case ~40 MB per text property at 100 000 rows (UTF-16),
   numbers and booleans ~0.8 MB each; the dataset is released on the next read).
2. **deck.gl for the projection canvas** — 2D + 3D in one library, binary attributes for 100k points; pinned 9.3.11 with
   `@deck.gl/widgets` 9.3.11, `@luma.gl/core`/`engine` 9.3.6 and `@loaders.gl/core` 4.4.5 (9.3.12 was under two weeks old).
3. **Filtered projections capped at the server's offset limit** — D-10, #30; the banner states the order basis
   ("first 10 000 in server order (server limit)").
4. **Metric-aware projection** — D-19: cosine collections are L2-normalised in the host before PCA/UMAP; dot and other
   metrics (manhattan and unknown strings included, U-37) use raw rows with the notice "<metric> metric: Euclidean
   layout"; non-cosine hit weights are the sign-safe `(d_max − d) + ε` (U-32).
5. **Local pre-push hooks in the fork** — D-17 revised: `.pre-commit-config.yaml` (typecheck, vitest, cargo fmt,
   clippy) at the pre-push stage, CI stays the gate.
6. **View-only colour and label; Run below the root** — D-21 (all candidate properties prefetched, memory cost above)
   and D-20 (method/dims edits re-run the current level; root-input edits ask before clearing the breadcrumb).

#### `ARCHITECTURE.md` (MODIFY)
- Tech Stack, "Weaviate browser" bullet: add the Projection tab, the `weavit-projector` Rust sidecar (umap-rs 0.4.5,
  ndarray, rayon) and deck.gl 9.3.11.
- Project Structure: `tools/weavit-ui/native/projector/` line.
- A short "Projection (Weavit fork)" note under Layer Responsibilities: host reads (lean cursor loop) → sidecar stdin →
  NDJSON frames → one session slot polled by the renderer; must NOT read through `exportObjects`, nor import
  `child_process` outside `src/main/projection/sidecar.ts`.

#### `tools/weavit-ui` (submodule pointer) — bump to the fork commit that contains Phases 1–4 (2a and 2b included).

## Tests
No new code paths in data-lab besides the script. Manual check: `tools/weavit-web.sh --rebuild` after the submodule
bump runs `pnpm install --frozen-lockfile` then `web:build`; `tools/weavit-web.sh` on a fresh clone builds the
binary, then the Projection tab works; with a deliberate compile error in the crate the warning prints and the server
still serves; with `cargo` removed from PATH the server still starts and the tab shows the
"binary not found" message naming `WEAVIT_PROJECTOR_BIN` and `pnpm projector:build`.

## Done when
Pre-push gates pass (`gates-app` and friends are unaffected); the data-lab PR references the fork PR; issues #29, #30,
#31 are linked from the ADRs.

<!-- plan-validate: READY 2026-11-07 sha256:917cc01b3e92 -->
