//! Randomized-SVD PCA (Halko) with a Jacobi-solved small decomposition.

use ndarray::{Array1, Array2, ArrayView2, Axis, Slice};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

const OVERSAMPLE: usize = 10;
const POWER_ITERATIONS: usize = 4;
const RANK_EPS: f64 = 1e-12;
const JACOBI_TOL: f64 = 1e-10;
const JACOBI_SWEEPS: usize = 100;
const B_CHUNK_ROWS: usize = 1024;

pub struct Basis {
    /// Fit mean, length D.
    pub mean: Array1<f32>,
    /// p x D, row-major, orthonormal rows (a zero row for a rank-deficient component).
    pub components: Array2<f32>,
}

impl Basis {
    /// Centers by the fit mean and projects onto the components: n x p.
    pub fn project(&self, rows: ArrayView2<f32>) -> Array2<f32> {
        let mut centered = rows.to_owned();
        centered -= &self.mean;
        centered.dot(&self.components.t())
    }
}

/// Fits a `p`-component basis on `rows`, deterministic for a given `seed`.
pub fn fit(rows: ArrayView2<f32>, p: usize, seed: u64) -> Basis {
    let (n, d) = rows.dim();
    let mean = column_mean(rows);
    let mut xc = rows.to_owned();
    xc -= &mean;
    let k = (p + OVERSAMPLE).min(n).min(d);
    let q = range_finder(&xc, k, seed);
    let b = project_to_small(&q, &xc);
    let components = components_from(&b, p.min(k), p);
    Basis { mean, components }
}

fn column_mean(rows: ArrayView2<f32>) -> Array1<f32> {
    let n = rows.nrows().max(1) as f64;
    rows.axis_iter(Axis(1))
        .map(|col| (col.iter().map(|&v| f64::from(v)).sum::<f64>() / n) as f32)
        .collect()
}

fn range_finder(xc: &Array2<f32>, k: usize, seed: u64) -> Array2<f32> {
    let mut rng = StdRng::seed_from_u64(seed);
    let omega = Array2::from_shape_fn((xc.ncols(), k), |_| rng.random_range(-1.0f32..1.0));
    let mut q = orthonormalize(xc.dot(&omega).view());
    for _ in 0..POWER_ITERATIONS {
        let z = orthonormalize(xc.t().dot(&q).view());
        q = orthonormalize(xc.dot(&z).view());
    }
    q
}

fn dot64(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| f64::from(x) * f64::from(y))
        .sum()
}

/// Modified Gram-Schmidt on the columns; a column that collapses is zeroed, never divided.
fn orthonormalize(a: ArrayView2<f32>) -> Array2<f32> {
    let (n, k) = a.dim();
    let mut cols: Vec<Vec<f32>> = (0..k).map(|j| a.column(j).to_vec()).collect();
    for j in 0..k {
        let (done, rest) = cols.split_at_mut(j);
        let cj = &mut rest[0];
        for ci in done.iter() {
            let r = dot64(ci, cj) as f32;
            cj.iter_mut().zip(ci).for_each(|(x, &y)| *x -= r * y);
        }
        let norm = dot64(cj, cj).sqrt();
        if norm < RANK_EPS {
            cj.fill(0.0);
        } else {
            let inv = (1.0 / norm) as f32;
            cj.iter_mut().for_each(|x| *x *= inv);
        }
    }
    Array2::from_shape_fn((n, k), |(i, j)| cols[j][i])
}

/// B = Qt . Xc (k x D) accumulated in f64 over row chunks.
fn project_to_small(q: &Array2<f32>, xc: &Array2<f32>) -> Array2<f64> {
    let mut b = Array2::<f64>::zeros((q.ncols(), xc.ncols()));
    for start in (0..xc.nrows()).step_by(B_CHUNK_ROWS) {
        let end = (start + B_CHUNK_ROWS).min(xc.nrows());
        let xq = xc
            .slice_axis(Axis(0), Slice::from(start..end))
            .mapv(f64::from);
        let qq = q
            .slice_axis(Axis(0), Slice::from(start..end))
            .mapv(f64::from);
        b += &qq.t().dot(&xq);
    }
    b
}

/// The first `take` right singular directions of B as a `p` x D matrix (rest zero).
fn components_from(b: &Array2<f64>, take: usize, p: usize) -> Array2<f32> {
    let gram = b.dot(&b.t());
    let (_, vecs) = jacobi_eigh(gram.view());
    let mut out = Array2::<f32>::zeros((p, b.ncols()));
    for i in 0..take {
        let mut c = b.t().dot(&vecs.column(i));
        let norm = c.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm < RANK_EPS {
            continue;
        }
        c /= norm;
        let sign = canonical_sign(c.as_slice().unwrap_or(&[]));
        for (dst, v) in out.row_mut(i).iter_mut().zip(c.iter()) {
            *dst = (sign * v) as f32;
        }
    }
    out
}

/// +1 when the largest-|loading| coordinate is positive, else -1 (U-16).
fn canonical_sign(c: &[f64]) -> f64 {
    let mut best = 0.0f64;
    for &v in c {
        if v.abs() > best.abs() {
            best = v;
        }
    }
    if best < 0.0 { -1.0 } else { 1.0 }
}

/// Cyclic Jacobi eigendecomposition of a symmetric matrix.
/// Returns eigenvalues descending and the matching eigenvectors as columns.
pub fn jacobi_eigh(s: ArrayView2<f64>) -> (Array1<f64>, Array2<f64>) {
    let n = s.nrows();
    let mut a = s.to_owned();
    let mut v = Array2::<f64>::eye(n);
    let total = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    for _ in 0..JACOBI_SWEEPS {
        let off = off_diagonal_norm(&a);
        if off == 0.0 || off < JACOBI_TOL * total {
            break;
        }
        for p in 0..n {
            for q in (p + 1)..n {
                rotate(&mut a, &mut v, p, q);
            }
        }
    }
    sorted_descending(&a, &v)
}

fn off_diagonal_norm(a: &Array2<f64>) -> f64 {
    let mut sum = 0.0;
    for ((i, j), x) in a.indexed_iter() {
        if i != j {
            sum += x * x;
        }
    }
    sum.sqrt()
}

fn rotate(a: &mut Array2<f64>, v: &mut Array2<f64>, p: usize, q: usize) {
    let apq = a[[p, q]];
    if apq.abs() < 1e-300 {
        return;
    }
    let theta = (a[[q, q]] - a[[p, p]]) / (2.0 * apq);
    let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
    let c = 1.0 / (t * t + 1.0).sqrt();
    let sn = t * c;
    for m in [&mut *a, &mut *v] {
        for k in 0..m.nrows() {
            let (kp, kq) = (m[[k, p]], m[[k, q]]);
            m[[k, p]] = c * kp - sn * kq;
            m[[k, q]] = sn * kp + c * kq;
        }
    }
    for k in 0..a.ncols() {
        let (pk, qk) = (a[[p, k]], a[[q, k]]);
        a[[p, k]] = c * pk - sn * qk;
        a[[q, k]] = sn * pk + c * qk;
    }
}

fn sorted_descending(a: &Array2<f64>, v: &Array2<f64>) -> (Array1<f64>, Array2<f64>) {
    let n = a.nrows();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| a[[j, j]].total_cmp(&a[[i, i]]));
    let vals = order.iter().map(|&i| a[[i, i]]).collect();
    let vecs = Array2::from_shape_fn((n, n), |(r, c)| v[[r, order[c]]]);
    (vals, vecs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::array;

    #[test]
    fn orthonormalize_zeroes_a_dependent_column() {
        let a = array![[1.0f32, 2.0], [0.0, 0.0], [0.0, 0.0]];
        let q = orthonormalize(a.view());
        assert_eq!(q.column(0).to_vec(), vec![1.0, 0.0, 0.0]);
        assert!(q.column(1).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn identical_rows_give_zero_components_not_nan() {
        let rows = Array2::from_elem((6, 4), 2.5f32);
        let basis = fit(rows.view(), 3, 1);
        assert!(basis.components.iter().all(|v| *v == 0.0));
        assert!(basis.project(rows.view()).iter().all(|v| *v == 0.0));
    }

    #[test]
    fn canonical_sign_flips_negative_peak() {
        assert_eq!(canonical_sign(&[0.1, -0.9, 0.2]), -1.0);
        assert_eq!(canonical_sign(&[0.1, 0.9, -0.2]), 1.0);
    }
}
