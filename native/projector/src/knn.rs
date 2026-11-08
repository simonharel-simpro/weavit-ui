//! Exact k-nearest-neighbours by blocked GEMM, parallel over query blocks.

use ndarray::{Array2, ArrayView2, Axis, Slice};
use rayon::prelude::*;

const BLOCK_ROWS: usize = 128;
const REF_TILE: usize = 4096;

/// Rows of one finished query block: first row index, indices and distances (rows x k each).
struct BlockResult {
    start: usize,
    indices: Vec<u32>,
    dists: Vec<f32>,
}

/// Sorted (ascending distance, then ascending index) best `cap` candidates of one query row.
struct TopK {
    cap: usize,
    d2: Vec<f32>,
    idx: Vec<u32>,
}

impl TopK {
    fn new(cap: usize) -> Self {
        Self {
            cap,
            d2: Vec::with_capacity(cap + 1),
            idx: Vec::with_capacity(cap + 1),
        }
    }

    /// Candidates arrive in ascending index order, so an equal distance never displaces
    /// an earlier (lower-index) entry.
    fn offer(&mut self, d2: f32, j: u32) {
        if self.cap == 0 || (self.d2.len() == self.cap && d2 >= self.d2[self.cap - 1]) {
            return;
        }
        let at = self.d2.partition_point(|&x| x <= d2);
        self.d2.insert(at, d2);
        self.idx.insert(at, j);
        self.d2.truncate(self.cap);
        self.idx.truncate(self.cap);
    }
}

/// Returns (indices n x k, distances n x k) with the point itself at column 0 (distance 0).
/// An empty slot (n <= k) holds `u32::MAX` / `f32::INFINITY`.
/// `progress(done, total)` is called after each group of blocks, in query rows.
pub fn exact_knn(
    x: ArrayView2<f32>,
    k: usize,
    progress: &mut dyn FnMut(usize, usize),
) -> (Array2<u32>, Array2<f32>) {
    let n = x.nrows();
    let norms: Vec<f32> = x
        .outer_iter()
        .map(|r| r.iter().map(|v| v * v).sum())
        .collect();
    let mut indices = Array2::from_elem((n, k), u32::MAX);
    let mut dists = Array2::from_elem((n, k), f32::INFINITY);
    let n_blocks = n.div_ceil(BLOCK_ROWS);
    let group = (2 * rayon::current_num_threads())
        .min(n_blocks.div_ceil(4))
        .max(1);
    for first in (0..n_blocks).step_by(group) {
        let ids: Vec<usize> = (first..(first + group).min(n_blocks)).collect();
        let results: Vec<BlockResult> = ids
            .par_iter()
            .map(|&b| knn_block(x, &norms, k, b * BLOCK_ROWS))
            .collect();
        for r in results {
            store(&mut indices, &mut dists, &r, k);
        }
        progress(((first + ids.len()) * BLOCK_ROWS).min(n), n);
    }
    (indices, dists)
}

fn store(indices: &mut Array2<u32>, dists: &mut Array2<f32>, r: &BlockResult, k: usize) {
    if k == 0 {
        return;
    }
    for (row, (ci, cd)) in r.indices.chunks(k).zip(r.dists.chunks(k)).enumerate() {
        indices
            .row_mut(r.start + row)
            .iter_mut()
            .zip(ci)
            .for_each(|(o, v)| *o = *v);
        dists
            .row_mut(r.start + row)
            .iter_mut()
            .zip(cd)
            .for_each(|(o, v)| *o = *v);
    }
}

fn knn_block(x: ArrayView2<f32>, norms: &[f32], k: usize, start: usize) -> BlockResult {
    let n = x.nrows();
    let end = (start + BLOCK_ROWS).min(n);
    let queries = x.slice_axis(Axis(0), Slice::from(start..end));
    let mut tops: Vec<TopK> = (start..end)
        .map(|_| TopK::new(k.saturating_sub(1)))
        .collect();
    for j0 in (0..n).step_by(REF_TILE) {
        let j1 = (j0 + REF_TILE).min(n);
        let tile = x.slice_axis(Axis(0), Slice::from(j0..j1));
        let g = queries.dot(&tile.t());
        for (r, top) in tops.iter_mut().enumerate() {
            let i = start + r;
            for (c, &dot) in g.row(r).iter().enumerate() {
                let j = j0 + c;
                if j != i {
                    top.offer((norms[i] + norms[j] - 2.0 * dot).max(0.0), j as u32);
                }
            }
        }
    }
    finish_block(start, k, &tops)
}

fn finish_block(start: usize, k: usize, tops: &[TopK]) -> BlockResult {
    let mut indices = vec![u32::MAX; tops.len() * k];
    let mut dists = vec![f32::INFINITY; tops.len() * k];
    for (r, top) in tops.iter().enumerate() {
        if k == 0 {
            break;
        }
        let row = r * k;
        indices[row] = (start + r) as u32;
        dists[row] = 0.0;
        for (c, (&d2, &j)) in top.d2.iter().zip(&top.idx).enumerate() {
            indices[row + 1 + c] = j;
            dists[row + 1 + c] = d2.sqrt();
        }
    }
    BlockResult {
        start,
        indices,
        dists,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::array;

    #[test]
    fn topk_keeps_lower_index_on_ties() {
        let mut t = TopK::new(2);
        for (d, j) in [(1.0, 0), (1.0, 1), (1.0, 2), (0.5, 3)] {
            t.offer(d, j);
        }
        assert_eq!(t.idx, [3, 0]);
    }

    #[test]
    fn small_n_leaves_sentinel_slots() {
        let x = array![[0.0f32, 0.0], [3.0, 4.0]];
        let (idx, dist) = exact_knn(x.view(), 3, &mut |_, _| {});
        assert_eq!(idx.row(0).to_vec(), [0, 1, u32::MAX]);
        assert_eq!(dist.row(0).to_vec(), [0.0, 5.0, f32::INFINITY]);
    }

    #[test]
    fn progress_ends_at_total() {
        let x = Array2::from_shape_fn((300, 3), |(i, j)| (i * 3 + j) as f32);
        let mut seen = Vec::new();
        exact_knn(x.view(), 4, &mut |d, t| seen.push((d, t)));
        assert_eq!(seen.last(), Some(&(300, 300)));
    }
}
