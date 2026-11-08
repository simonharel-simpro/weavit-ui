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
