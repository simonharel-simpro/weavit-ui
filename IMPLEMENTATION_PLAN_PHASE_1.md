# Phase 1 — Rust sidecar `weavit-projector` + Rust CI job + local pre-push hooks

**Depends on:** nothing. **Agent:** `rust-cli`. **Repo:** Weavit UI fork, worktree
`/home/simon/projects/data-science/worktrees/weavit-projector`, branch `feat/embedding-projector`.

## Goal
A standalone binary that reads vectors on stdin and streams projections on stdout: PCA (progressively, as rows
arrive), then exact kNN + UMAP. The Node host (Phase 2a/2b) spawns it; nothing else talks to it. Measured target on
6 cores: 100k × 384 → PCA-50 ~2 s, exact kNN 17.6 s, UMAP 200 epochs 12–15 s; 20k → ~3 s total.
The sidecar is metric-agnostic: the host normalises rows for cosine collections before streaming (D-19); Rust always
works in Euclidean space.

## Protocol v1 (the contract Phase 2a implements — keep it exact)

**stdout, first line, before reading stdin:** `{"type":"hello","protocol":1}`

**stdin:** one JSON header line, then little-endian f32 rows of `dim` values each, until EOF.
```json
{"protocol":1,"nMax":100000,"dim":384,"method":"umap","dims":3,"pcaDims":50,"nNeighbors":15,
 "minDist":0.1,"epochs":200,"seed":42,"frameEvery":10,"batchRows":1000,"fitRows":10000}
```
- `nMax` is an upper bound for preallocation only. **EOF on a row boundary ends the data**; actual n = rows read.
  EOF mid-row → `error` (F-1).
- `method`: `"pca"` (stop after PCA) or `"umap"`. `dims` ∈ {2,3} applies to UMAP only (PCA always emits 3 columns).
- `seed` drives the randomized SVD only (U-16); `umap-rs` 0.4.5 `UmapConfig` has no seed field.
- **Header rejection rules** (each → `error` line, exit 2; one fixture per rule, see Files): bad JSON; unknown field;
  `protocol` ≠ 1; `method` ∉ {pca, umap}; `dim` < 2; `dims` ∉ {2,3}; `nMax` < 1; `pcaDims` < 1; `nNeighbors` < 2;
  `minDist` ≤ 0 or > 1 (must also be ≤ `spread`, which stays at the umap-rs default 1.0); `epochs` < 1;
  `frameEvery` < 1; `batchRows` < 1; `fitRows` < 1; `nMax * dim` > `100_000 * 1024`; any non-finite number.

**stdout NDJSON messages** (f32 arrays are little-endian bytes, standard base64; every key camelCase):
| type | fields | when |
|---|---|---|
| `hello` | `protocol: 1` | first line |
| `progress` | `stage: "pca"\|"knn"\|"graph"\|"epochs"`, `done`, `total` — units: for `pca`, `done` = **rows projected** and `total` = rows received so far (n is unknown before EOF); query rows for `knn`, 0/1 for `graph`, epochs for `epochs` | during work; at least once per kNN block group (every ≤ 2 s of work) and per UMAP frame (F-7) |
| `basis` | `mean` (b64, D), `components` (b64, p×D row-major), `pcaDims: p` | once, when the basis is fitted |
| `pcaChunk` | `offset`, `count`, `coords` (b64, count×3) | after the fit for all rows read so far, then per `batchRows` new rows, and a last one at EOF |
| `pca50` | `n`, `pcaDims`, `coords` (b64, n×p) | once after EOF (method umap and pca) — the host uses it for query placement (D-16) |
| `notice` | `message` | e.g. `"UMAP needs at least 16 points; PCA only"` |
| `frame` | `stage: "umap"`, `epoch`, `epochs`, `dims`, `n`, `coords` (b64, n×dims) | every `frameEvery` epochs and at the end |
| `done` | `n` | last line on success, exit 0 |
| `error` | `message` | last line on failure, exit ≠ 0 |

**Exit codes:** 0 success · 2 header error · 3 stdout `BrokenPipe` (host gone, exit quietly, F-13) · 1 anything else.

## Algorithms
- **PCA fit** on the first `min(fitRows, n)` rows (cursor order is quasi-random by UUID). Center by the fit mean.
  `p = min(pcaDims, nFit − 1, dim)`, at least 1. Randomized SVD (Halko): oversampling 10, 4 power iterations,
  modified Gram-Schmidt QR, `StdRng::seed_from_u64(seed)`. **Rank guard (U-38):** `k = min(p + 10, nFit, dim)`; a
  Gram-Schmidt column whose norm is < 1e-12 after orthogonalisation is set to zero (never divided), and so is a final
  component with ‖u_iᵀ·B‖ < 1e-12 — a zero component projects every row to 0. **Small decomposition (no new crate):**
  with Q (nFit×k, k ≤ 60) from the range finder, B = Qᵀ·Xc (k×D); eigendecompose S = B·Bᵀ (k×k, symmetric, in f64) by
  **cyclic Jacobi** — stop when the off-diagonal Frobenius norm < 1e-10 · ‖S‖_F or after 100 sweeps; sort eigenpairs by
  eigenvalue descending; component_i = (u_iᵀ·B) / ‖u_iᵀ·B‖ for i < p. **Sign canonical:** flip each component so its
  largest-|loading| coordinate is positive (U-16). Every row (fit rows included) is projected with the same basis — no refit later.
- **PCA coords for display** = first 3 components; zero-padded when p < 3 (U-9).
- **Finite check (U-38):** `basis`, every `pcaChunk` and `pca50` are checked finite before they are written; a
  non-finite value → `RunError::Pca("non-finite …")`, an `error` line naming "pca", exit 1.
- **kNN**: exact, on PCA-p coords, blocked GEMM (`d = |a|² + |b|² − 2a·b`, clamp ≥ 0, sqrt), blocks of 128 rows,
  rayon over blocks, top-k by insertion. **k = `nNeighbors`, self included at rank 0 with distance 0** (umap-rs
  `learn_manifold` panics unless the knn width equals `n_neighbors`: check at `embedding.rs:406`, message at `:408`). Self is forced to rank 0 even
  when duplicates also sit at distance 0; the other ties at rank k → lower index. A slot with no neighbour holds the
  sentinel `u32::MAX` / `f32::INFINITY` (umap-rs accepts it); with n > nNeighbors it never occurs.
- **UMAP**: `Umap::new(cfg).learn_manifold(data, knn_indices.view(), knn_dists.view())`, then
  `Optimizer::new(manifold, init, epochs, &cfg, EuclideanMetric.metric_type())` (crate imported as `umap_rs`:
  `use umap_rs::{…}`). Loop while
  `opt.remaining_epochs() > 0` (`optimizer.rs:379`): `opt.step_epochs(min(frame_every, opt.remaining_epochs()),
  &EuclideanMetric)` — `step_epochs` asserts it never passes `total_epochs` (`optimizer.rs:297`) — then emit a frame.
  `init` = PCA comps 0..dims scaled to max-abs 10; when that max-abs is 0 (every PCA coord 0, e.g. identical rows) the
  init is left unscaled — never a division by zero (U-38). Every frame checked finite; non-finite → `error` naming "umap" (F-11).
  `learn_manifold` also panics on `n_samples <= n_neighbors`, `n_neighbors < 2`, `min_dist > spread`
  (`embedding.rs:353-424`): the header rules and the F-18 branch make those unreachable, and both umap-rs calls run
  inside `std::panic::catch_unwind(AssertUnwindSafe(|| …))` (the closures borrow `&mut` state, so `AssertUnwindSafe`
  is required) so a panic becomes `RunError::Umap(message)`, never an abort without `error`.
- **n ≤ nNeighbors** with method umap → `notice` + PCA output + `done` (F-18). n = 0 → `RunError::NoRows` ("no rows").

## Files

#### `native/projector/Cargo.toml` (NEW)
**Purpose:** crate `weavit-projector`, edition 2024, one binary + a lib for tests.
**Dependencies (exact pins):** `umap-rs = "=0.4.5"`, `ndarray = "0.17"`, `rayon = "1.12"`, `serde = {version="1", features=["derive"]}`,
`serde_json = "1"`, `base64 = "0.23"`, `rand = "0.9"`, `thiserror = "2"`. Only `umap-rs` is pinned with `=`; the
committed `Cargo.lock` pins every other crate (and every transitive one) and CI builds with `--locked`.
**Dev-dependencies:** `rand_distr = "=0.5.1"` (gaussian test data; the version that pairs with rand 0.9).
**Profile:** `[profile.release] opt-level=3, lto="thin", codegen-units=1`. Commit `Cargo.lock`.

#### `native/projector/src/main.rs` (NEW)
**Purpose:** thin entry. Prints `hello`, calls `weavit_projector::run(stdin.lock(), stdout.lock())`, maps `Err(e)` to an
`error` line and `std::process::exit(e.exit_code())`. No `unwrap` on I/O. On `RunError::Io` with
`ErrorKind::BrokenPipe` write nothing and exit 3 (F-13).

#### `native/projector/src/lib.rs` (NEW)
```rust
pub fn run(input: impl BufRead, out: impl Write) -> Result<(), RunError>
#[derive(Debug, thiserror::Error)]
pub enum RunError { #[error("header: {0}")] Header(String), #[error("input ended mid-row")] ShortRow,
  #[error("non-finite value in row {row}")] NonFinite { row: usize }, #[error("more rows than nMax")] TooManyRows,
  #[error("no rows")] NoRows, #[error("pca: {0}")] Pca(String), #[error("umap: {0}")] Umap(String), #[error(transparent)] Io(#[from] std::io::Error) }
impl RunError { pub fn exit_code(&self) -> i32 } // Header → 2, Io(BrokenPipe) → 3, everything else → 1
```
Declares `pub mod protocol; pub mod input; pub mod pca; pub mod knn; pub mod umap_run;` (`tests/run.rs` calls
`pca::fit` and `knn::exact_knn` directly). Orchestrates: header → read rows in `batchRows` chunks → fit basis when `fitRows` rows or EOF → `pcaChunk`s → `pca50`
→ (umap) kNN with progress → graph → epochs with frames → `done`.

#### `native/projector/src/protocol.rs` (NEW)
- `#[derive(Deserialize, Clone, Copy, PartialEq, Debug)] #[serde(rename_all = "lowercase")] pub enum Method { Pca, Umap }`.
- `#[derive(Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)] pub struct Header { pub protocol: u32,
  pub n_max: usize, pub dim: usize, pub method: Method, pub dims: usize, pub pca_dims: usize, pub n_neighbors: usize,
  pub min_dist: f32, pub epochs: usize, pub seed: u64, pub frame_every: usize, pub batch_rows: usize,
  pub fit_rows: usize }` (all fields `pub`: the tests build and read headers) with
  `pub fn validate(&self) -> Result<(), RunError>` applying every rejection rule above.
- `#[derive(Serialize)] #[serde(tag = "type", rename_all = "camelCase")] pub enum Message { … }` and **each struct
  variant also carries `#[serde(rename_all = "camelCase")]`** so its fields serialize as `pcaDims`, not `pca_dims`.
- `pub fn encode_f32(values: &[f32]) -> String`, `pub const PROTOCOL: u32 = 1`,
  `pub fn write_message(out: &mut impl Write, m: &Message) -> std::io::Result<()>` (one `write_all` + `\n`).

#### `native/projector/src/input.rs` (NEW)
`RowReader::new(input: impl BufRead, dim: usize, n_max: usize)`;
`RowReader::next_batch(&mut self, max_rows: usize) -> Result<Option<Array2<f32>>, RunError>`: reads exact `dim*4`-byte
rows; `Ok(None)` on EOF at a row boundary; `Err(ShortRow)` on EOF mid-row; `Err(NonFinite{row})` on NaN/inf; more than
`nMax` rows → `Err(TooManyRows)`.

#### `native/projector/src/pca.rs` (NEW)
`pub struct Basis { pub mean: Array1<f32>, pub components: Array2<f32> /* p×D */ }`;
`pub fn fit(rows: ArrayView2<f32>, p: usize, seed: u64) -> Basis`; `pub fn jacobi_eigh(s: ArrayView2<f64>) ->
(Array1<f64>, Array2<f64>)` (eigenvalues descending, eigenvectors as columns); `impl Basis { pub fn project(&self, rows:
ArrayView2<f32>) -> Array2<f32> }`.

#### `native/projector/src/knn.rs` (NEW)
`pub fn exact_knn(x: ArrayView2<f32>, k: usize, progress: &mut dyn FnMut(usize, usize)) -> (Array2<u32>, Array2<f32>)`
— returns (indices n×k, distances n×k), self at column 0.

#### `native/projector/src/umap_run.rs` (NEW)
`pub fn run_umap(pca: ArrayView2<f32>, knn: (ArrayView2<u32>, ArrayView2<f32>), dims: usize, n_neighbors: usize,
min_dist: f32, epochs: usize, frame_every: usize, on_frame: &mut dyn FnMut(usize, ArrayView2<f32>) -> std::io::Result<()>)
-> Result<(), RunError>` — no `seed` argument.

#### `native/projector/fixtures/protocol-v1/` (NEW, shared with Phase 2a vitest)
- `header.valid.json` (the header above, exactly the TS `encodeHeader(defaults)` output) and
  `header.valid.at-limit.json` (`nMax` 100 000, `dim` 1024: `nMax * dim` equals the cap exactly, so it is accepted; the
  TS suite asserts the same product equals `MAX_CELLS`).
- One `header.invalid.<rule>.json` per rejection rule: `bad-json`, `unknown-field`, `protocol-2`, `method-tsne`, `dim-1`,
  `dims-4`, `nmax-0`, `pca-dims-0`, `neighbors-1`, `min-dist-0`, `min-dist-1.5`, `epochs-0`, `frame-every-0`,
  `batch-rows-0`, `fit-rows-0`, `too-large` (`nMax` 100 001, `dim` 1024), `non-finite` (`"minDist":1e999`).
- `rows.3x4.f32` + `rows.3x4.json` (3 rows of dim 4 as bytes and as JSON numbers).
- `messages.ndjson`: one sample line of every message type, `hello` first, and one `progress` line for each of the 4
  stages (`pca`, `knn`, `graph`, `epochs`), with small b64 payloads whose decoded values
  are listed in `messages.expected.json`.

#### `native/projector/tests/protocol.rs`, `tests/run.rs` (NEW) — see Tests.

#### `.pre-commit-config.yaml` (NEW) — local hook runner (D-17 revised)
`default_install_hook_types: [pre-push]`; one `repo: local` with four hooks, each `language: system`,
`pass_filenames: false`, `always_run: true`, `stages: [pre-push]`:
`typecheck` → `pnpm typecheck` · `vitest` → `pnpm test` ·
`cargo-fmt` → `cargo fmt --manifest-path native/projector/Cargo.toml --check` ·
`cargo-clippy` → `cargo clippy --manifest-path native/projector/Cargo.toml --all-targets -- -D warnings`.

#### `README.md` (MODIFY) — "Getting started" (`README.md:148`)
After `pnpm install`, add: the Rust toolchain (`rustup`, 1.96.0) and `pnpm projector:build` for the Projection tab;
`pipx install pre-commit && pre-commit install --hook-type pre-push` to run the gates locally before a push.

#### `package.json` (MODIFY)
Add script `"projector:build": "cargo build --release --manifest-path native/projector/Cargo.toml"`.

#### `.gitignore` (MODIFY) — add `native/projector/target/`.

#### `.github/workflows/ci.yml` (MODIFY)
Add job `projector` (ubuntu-latest): `actions/checkout@v4` (the ref `ci.yml:12` already uses); `dtolnay/rust-toolchain@1.96.0`
with `components: clippy, rustfmt, llvm-tools-preview`; `Swatinem/rust-cache@v2` (`workspaces: native/projector`);
`taiki-e/install-action@v2` with `tool: cargo-llvm-cov@0.9.1` (crates.io, published 2026-09-06); in
`native/projector`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --locked`,
`cargo llvm-cov --locked --fail-under-lines 70`. Every action ref above is a tag published ≥ 2 weeks before 2026-11-07.

## Tests (cargo; expected values come from this spec)

| Test | Given → expected | Source |
|---|---|---|
| `f_9_first_line_is_hello_with_protocol_version` | run binary, close stdin → first line `{"type":"hello","protocol":1}` | F-9 |
| `header_valid_fixture_parses` | `header.valid.json` → `Header` with `n_max` 100 000, `pca_dims` 50, `frame_every` 10; `validate()` is `Ok` | protocol |
| `header_at_limit_is_accepted` | `header.valid.at-limit.json` → `validate()` is `Ok` (100 000 × 1024 is not above the cap) | D-8 |
| `header_rejections_from_fixtures` | each of the 17 `header.invalid.*.json` → `error` line, exit 2 (the test lists the 17 names, so a missing fixture fails) | protocol |
| `message_fields_are_camel_case` | serialize `pca50{n:2,pcaDims:3,…}` and `frame` → JSON keys `pcaDims`, `epochs`, no `_` in any key | protocol |
| `f_13_exits_when_stdin_closes_before_header` | empty stdin → `hello`, `error`, exit ≠ 0 within 1 s | F-13 |
| `f_13_broken_pipe_exits_3` | stdout reader closed after `hello`, 2 000 rows → exit code 3, no panic message on stderr | F-13 |
| `f_1_eof_before_nmax_completes_with_actual_n` | nMax=1000, dim 8, 998 rows, method pca → `done{n:998}`, exit 0, `pcaChunk` counts sum to 998 | F-1 |
| `f_1_eof_mid_row_is_error` | 998 rows + 3 extra floats → `error` mentioning "row", exit 1 | F-1 |
| `non_finite_row_is_error` | row 5 contains NaN → `error` "non-finite value in row 5", exit 1 | D-15 |
| `pca_recovers_known_axes` | 2 000 rows = 3 latent gaussians (σ 10, 5, 2; `rand_distr::Normal`, seed 7) on known orthonormal axes in dim 20 + noise σ 0.01 → `basis.pcaDims` = 20 (p clamped by D), k = 20; \|cos(component_i, axis_i)\| > 0.999 for i=0..2; components orthonormal (±1e-4) | PCA |
| `u_16_pca_sign_is_canonical` | the known-axes data above with n = 1 000 ≤ fitRows (so both runs fit on the same rows), run once in order and once reversed → the **top 3** components equal (±1e-4) and each of them has its largest-\|loading\| > 0 | U-16 |
| `u_2_selection_run_fits_its_own_basis` | rows = subset S → `basis.mean` = mean(S) (±1e-5) | U-2 |
| `u_9_pca_dims_clamped_and_padded` | n=3, dim 384, method pca → `basis.pcaDims` = 2 (nFit − 1), k = 3 (nFit), `pcaChunk` coords 3×3 all finite with column 2 all 0 | U-9 |
| `u_38_pca_is_finite_on_degenerate_input` | (a) n=20, dim 384 · (b) n=1, dim 8 → `pcaDims` 1, coords all 0 · (c) 50 identical rows, dim 16, **method umap** (the default header) → every `basis`, `pcaChunk`, `pca50` and `frame` value finite, `done{n:50}` — covers the zero max-abs init guard | U-38 |
| `u_52_pca_progress_counts_rows` | n=2 500, fitRows 1 000, batchRows 500, method pca → `progress{stage:"pca"}` `done` ends at 2 500 = `total` | U-52 |
| `pca_chunks_cover_every_row_in_order` | n=2 500, fitRows 1 000, batchRows 500 → chunks (0,1000),(1000,500),(1500,500),(2000,500) | protocol |
| `knn_matches_brute_force` | 500 random rows dim 10, k 15 → indices equal a naive O(n²) search (ties by lower index), column 0 = self with distance 0 | D-2 |
| `knn_self_first_with_duplicates` | rows 0 and 1 identical, k 3 → row 1's column 0 is 1 (self), column 1 is 0 | D-2 |
| `f_7_knn_emits_progress_per_block` | n=2 000 → ≥ 2 `progress{stage:"knn"}` lines, `done` non-decreasing, last `done == total` | F-7 |
| `umap_frames_every_k_epochs` | n=600, 3 clusters, epochs 30, frameEvery 10, dims 2 → 3 `frame` lines (epoch 10,20,30), coords length 600×2, all finite | protocol |
| `umap_last_step_is_clamped` | n=600, epochs 25, frameEvery 10 → frames at epochs 10, 20, 25; no panic | umap-rs |
| `umap_separates_clusters` | 3 well-separated clusters × 200 → mean intra-cluster distance < 0.5 × mean inter-centroid distance in the final frame | UMAP |
| `f_11_half_duplicate_rows_produce_finite_umap_coords` | 2 000 rows, 1 000 identical → all coords finite (or a clean `error` naming "umap"; never NaN in a frame) | F-11 |
| `f_18_n_below_neighbors_yields_pca_only` | n=10, method umap, nNeighbors 15 → `notice`, `pca50`, `done{n:10}`, no `frame` | F-18 |
| `f_18_n_equal_neighbors_yields_pca_only` | n=15, nNeighbors 15 → `notice`, `done{n:15}`, no `frame`, no panic | F-18 |
| `fixture_messages_round_trip` | parse `messages.ndjson` → decoded arrays equal `messages.expected.json`; the first line is `hello` with `protocol == PROTOCOL`; the 4 `progress` lines carry stages pca, knn, graph, epochs | S-14 |
| `jacobi_matches_known_eigenpairs` | S = diag(5, 3, 1) rotated by a known orthonormal R → eigenvalues [5, 3, 1] (±1e-9), eigenvectors = columns of R up to sign | PCA |

## Constraints
- No `unwrap`/`expect` outside tests; `clippy -D warnings` clean; `cargo fmt`.
- Only stdout carries protocol lines; debug output goes to stderr (and stays minimal).
- No network, no filesystem writes, no env reads (all params in the header).
- Write each message with a single `write_all` + `\n`, flush after `hello`, `done`, `error`, and every `frame`/`progress`.
- Functions ≤ 30 lines where practical; modules ≤ 200 lines.

## Done when
`pnpm projector:build` produces the binary; all tests above pass; `cargo fmt --check`, `clippy -D warnings`,
`cargo llvm-cov --fail-under-lines 70` pass locally; the CI job is in `ci.yml`; `pre-commit run --hook-stage pre-push
--all-files` passes. Quick bench: 100k × 384 synthetic through the binary (method umap, dims 3) completes in < 60 s on
this machine — report the timing.

<!-- plan-validate: READY 2026-11-07 sha256:d1855a0fe9ad -->
