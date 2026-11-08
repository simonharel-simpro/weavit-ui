# Testing Scenarios — embedding projector

| ID | Scenario | Input | Expected Output | Status | Last Modified |
|----|----------|-------|-----------------|--------|---------------|
| PRJ-01 | Sidecar PCA + UMAP on 100k × 384 | header + rows on stdin | hello, pcaChunk…, frames every 10 epochs, done{n} in < 60 s | 🆕 New | Phase 1 |
| PRJ-02 | Invalid header | each `header.invalid.*.json` | `error` line, exit 2 | 🆕 New | Phase 1 |
| PRJ-03 | Tiny set | n ≤ nNeighbors | PCA only + notice | 🆕 New | Phase 1 |
| PRJ-04 | Degenerate input | 50 identical rows / n=1 | finite outputs, done | 🆕 New | Phase 1 |
| PRJ-05 | Host closes stdout early | broken pipe | exit 3 | 🆕 New | Phase 1 |
| PRJ-06 | Cosine collection | unnormalised vectors | rows L2-normalised before the sidecar | 🆕 New | Phase 2a |
| PRJ-07 | Bad vectors | missing / wrong length / NaN / zero-norm | skipped and counted per reason | 🆕 New | Phase 2a |
| PRJ-08 | Multi-vector space | colbert vector | rejected at start, nothing fetched | 🆕 New | Phase 2a |
| PRJ-09 | Stale or old binary | hello mismatch | killed, "rebuild the projector" message | 🆕 New | Phase 2a |
| PRJ-10 | Slow Weaviate | pages 7 s apart | watchdog does not kill | 🆕 New | Phase 2a |
| PRJ-11 | Read then drill down | 41-pt collection, select 20 | both runs done; root basis still places | 🆕 New | Phase 2b |
| PRJ-12 | New start while running | second start | first killed only when the second commits | 🆕 New | Phase 2b |
| PRJ-13 | Cancel mid-read | cancel after page 1 | partial dataset, points served, lasso disabled | 🆕 New | Phase 2b |
| PRJ-14 | Unknown job | status('nope') | {state:'unknown'}, no throw | 🆕 New | Phase 2b |
| PRJ-15 | Web host shutdown | SIGTERM | no orphan sidecar | 🆕 New | Phase 2b |
| PRJ-16 | Open the Projection tab | MiniRag collection, default controls | UMAP 2D runs; progress; points drawn | 🆕 New | Phase 3 |
| PRJ-17 | 2D ↔ 3D | toggle dims | PCA instant; UMAP marked stale until Run | 🆕 New | Phase 3 |
| PRJ-18 | Change Colour / Label | pick another property | recoloured instantly, no new run | 🆕 New | Phase 3 |
| PRJ-19 | Click a point | point in view | object drawer opens with that object | 🆕 New | Phase 3 |
| PRJ-20 | Cancel | during UMAP | cancelled badge, last frame kept | 🆕 New | Phase 3 |
| PRJ-21 | Tab switch and back | leave and return | controls restored from status scope | 🆕 New | Phase 3 |
| PRJ-22 | Lasso a cluster in 2D | ≥ 16 points | "UMAP on selection" → level 2 in breadcrumb | 🆕 New | Phase 4 |
| PRJ-23 | Back in breadcrumb | from level 2 | level 1 frames drawn; in-flight child cancelled | 🆕 New | Phase 4 |
| PRJ-24 | Root input edited at level 2 | change filter, Run | confirm "clears the breadcrumb", root run on accept | 🆕 New | Phase 4 |
| PRJ-25 | Text query overlay | nearText "pump" | hits highlighted, marker "approximate (hit centroid)" | 🆕 New | Phase 4 |
| PRJ-26 | Vector query in PCA view | vector of length D | exact marker | 🆕 New | Phase 4 |
| PRJ-27 | Wrong-length vector | length ≠ D | inline error, no request | 🆕 New | Phase 4 |
| PRJ-28 | Use as query | tooltip action on a point | search runs with that object | 🆕 New | Phase 4 |
