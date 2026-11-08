#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "integration tests may panic on failure"
)]

mod common;

use common::*;
use ndarray::{Array2, array};
use rand::SeedableRng;
use rand::rngs::StdRng;
use rand_distr::{Distribution, Normal};
use serde_json::json;
use weavit_projector::knn::exact_knn;
use weavit_projector::pca::{self, jacobi_eigh};

fn with(mut h: serde_json::Value, kv: serde_json::Value) -> serde_json::Value {
    for (k, v) in kv.as_object().unwrap() {
        h[k] = v.clone();
    }
    h
}

/// 3 latent gaussians (sigma 10, 5, 2) on known orthonormal axes in dim 20, noise 0.01.
fn known_axes(n: usize) -> (Vec<Vec<f32>>, [Vec<f32>; 3]) {
    let axes: [Vec<f32>; 3] = std::array::from_fn(|a| {
        let mut v = vec![0.0f32; 20];
        v[a * 3] = 0.6;
        v[a * 3 + 1] = 0.8;
        v
    });
    let mut rng = StdRng::seed_from_u64(7);
    let unit = Normal::new(0.0f32, 1.0).unwrap();
    let noise = Normal::new(0.0f32, 0.01).unwrap();
    let sigmas = [10.0f32, 5.0, 2.0];
    let rows = (0..n)
        .map(|_| {
            let z: Vec<f32> = sigmas.iter().map(|s| s * unit.sample(&mut rng)).collect();
            (0..20)
                .map(|d| (0..3).map(|a| z[a] * axes[a][d]).sum::<f32>() + noise.sample(&mut rng))
                .collect()
        })
        .collect();
    (rows, axes)
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[test]
fn f_1_eof_before_nmax_completes_with_actual_n() {
    let out = run_rows(&header(1000, 8, "pca"), &gaussian_rows(998, 8, 3));
    assert_eq!(out.code, 0);
    assert_eq!(out.one("done")["n"], 998);
    let total: u64 = out
        .of_type("pcaChunk")
        .iter()
        .map(|c| c["count"].as_u64().unwrap())
        .sum();
    assert_eq!(total, 998);
}

#[test]
fn f_1_eof_mid_row_is_error() {
    let mut stdin = format!("{}\n", header(1000, 8, "pca")).into_bytes();
    stdin.extend(f32_bytes(&gaussian_rows(998, 8, 3)));
    stdin.extend(f32_bytes(&[vec![1.0, 2.0, 3.0]]));
    let out = run_bytes(stdin);
    assert_eq!(out.code, 1);
    assert!(out.error_message().contains("row"));
}

#[test]
fn non_finite_row_is_error() {
    let mut rows = gaussian_rows(20, 4, 3);
    rows[5][2] = f32::NAN;
    let out = run_rows(&header(20, 4, "pca"), &rows);
    assert_eq!(out.code, 1);
    assert_eq!(out.error_message(), "non-finite value in row 5");
}

#[test]
fn pca_recovers_known_axes() {
    let (rows, axes) = known_axes(2000);
    let out = run_rows(&header(2000, 20, "pca"), &rows);
    let basis = out.one("basis");
    assert_eq!(basis["pcaDims"], 20);
    let comps = decode(&basis["components"]);
    let comp = |i: usize| &comps[i * 20..(i + 1) * 20];
    for (i, axis) in axes.iter().enumerate() {
        assert!(dot(comp(i), axis).abs() > 0.999, "axis {i}");
    }
    for i in 0..20 {
        for j in 0..20 {
            let want = if i == j { 1.0 } else { 0.0 };
            assert!(
                (dot(comp(i), comp(j)) - want).abs() < 1e-4,
                "orthonormal {i},{j}"
            );
        }
    }
}

#[test]
fn u_16_pca_sign_is_canonical() {
    let (rows, _) = known_axes(1000);
    let mut reversed = rows.clone();
    reversed.reverse();
    let a = decode(&run_rows(&header(1000, 20, "pca"), &rows).one("basis")["components"]);
    let b = decode(&run_rows(&header(1000, 20, "pca"), &reversed).one("basis")["components"]);
    for i in 0..3 {
        let (ca, cb) = (&a[i * 20..(i + 1) * 20], &b[i * 20..(i + 1) * 20]);
        for (x, y) in ca.iter().zip(cb) {
            assert!((x - y).abs() < 1e-4, "component {i}");
        }
        let big = ca
            .iter()
            .cloned()
            .fold(0.0f32, |m, v| if v.abs() > m.abs() { v } else { m });
        assert!(big > 0.0, "component {i} largest loading positive");
    }
}

#[test]
fn u_2_selection_run_fits_its_own_basis() {
    let rows = gaussian_rows(40, 6, 11);
    let subset = &rows[10..30];
    let out = run_rows(&header(20, 6, "pca"), subset);
    let mean = decode(&out.one("basis")["mean"]);
    for d in 0..6 {
        let want = subset.iter().map(|r| r[d] as f64).sum::<f64>() / 20.0;
        assert!((mean[d] as f64 - want).abs() < 1e-5, "dim {d}");
    }
}

#[test]
fn u_9_pca_dims_clamped_and_padded() {
    let out = run_rows(&header(3, 384, "pca"), &gaussian_rows(3, 384, 5));
    assert_eq!(out.one("basis")["pcaDims"], 2);
    let coords = decode(&out.one("pcaChunk")["coords"]);
    assert_eq!(coords.len(), 9);
    assert!(coords.iter().all(|v| v.is_finite()));
    assert!((0..3).all(|r| coords[r * 3 + 2] == 0.0));
}

fn assert_all_finite(out: &Output) {
    for ty in ["pcaChunk", "pca50", "frame"] {
        for m in out.of_type(ty) {
            assert!(decode(&m["coords"]).iter().all(|v| v.is_finite()), "{ty}");
        }
    }
    let b = out.one("basis");
    assert!(
        decode(&b["mean"])
            .iter()
            .chain(&decode(&b["components"]))
            .all(|v| v.is_finite())
    );
}

#[test]
fn u_38_pca_is_finite_on_degenerate_input() {
    let a = run_rows(&header(20, 384, "umap"), &gaussian_rows(20, 384, 2));
    assert_eq!(a.code, 0);
    assert_all_finite(&a);

    let b = run_rows(&header(1, 8, "umap"), &gaussian_rows(1, 8, 2));
    assert_eq!(b.one("basis")["pcaDims"], 1);
    assert!(
        decode(&b.one("pcaChunk")["coords"])
            .iter()
            .all(|v| *v == 0.0)
    );

    let c = run_rows(
        &with(header(50, 16, "umap"), json!({"epochs": 20})),
        &vec![vec![1.5; 16]; 50],
    );
    assert_eq!(c.code, 0, "{}", c.stderr);
    assert_all_finite(&c);
    assert_eq!(c.one("done")["n"], 50);
}

#[test]
fn u_52_pca_progress_counts_rows() {
    let h = with(
        header(2500, 8, "pca"),
        json!({"fitRows":1000,"batchRows":500}),
    );
    let out = run_rows(&h, &gaussian_rows(2500, 8, 4));
    let last = out
        .of_type("progress")
        .into_iter()
        .rfind(|p| p["stage"] == "pca")
        .unwrap()
        .clone();
    assert_eq!(
        (last["done"].as_u64(), last["total"].as_u64()),
        (Some(2500), Some(2500))
    );
}

#[test]
fn pca_chunks_cover_every_row_in_order() {
    let h = with(
        header(2500, 8, "pca"),
        json!({"fitRows":1000,"batchRows":500}),
    );
    let out = run_rows(&h, &gaussian_rows(2500, 8, 4));
    let chunks: Vec<(u64, u64)> = out
        .of_type("pcaChunk")
        .iter()
        .map(|c| (c["offset"].as_u64().unwrap(), c["count"].as_u64().unwrap()))
        .collect();
    assert_eq!(chunks, [(0, 1000), (1000, 500), (1500, 500), (2000, 500)]);
}

fn naive_knn(rows: &[Vec<f32>], i: usize, k: usize) -> Vec<usize> {
    let mut d: Vec<(f32, usize)> = (0..rows.len())
        .map(|j| {
            (
                rows[i]
                    .iter()
                    .zip(&rows[j])
                    .map(|(a, b)| (a - b) * (a - b))
                    .sum::<f32>()
                    .sqrt(),
                j,
            )
        })
        .collect();
    d.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    d.into_iter().take(k).map(|(_, j)| j).collect()
}

fn to_array(rows: &[Vec<f32>]) -> Array2<f32> {
    Array2::from_shape_vec((rows.len(), rows[0].len()), rows.concat()).unwrap()
}

#[test]
fn knn_matches_brute_force() {
    let rows = gaussian_rows(500, 10, 21);
    let (idx, dist) = exact_knn(to_array(&rows).view(), 15, &mut |_, _| {});
    for i in 0..500 {
        let want = naive_knn(&rows, i, 15);
        let got: Vec<usize> = idx.row(i).iter().map(|&j| j as usize).collect();
        assert_eq!(got, want, "row {i}");
        assert_eq!(idx[[i, 0]] as usize, i);
        assert_eq!(dist[[i, 0]], 0.0);
    }
}

#[test]
fn knn_self_first_with_duplicates() {
    let mut rows = gaussian_rows(10, 4, 8);
    rows[1] = rows[0].clone();
    let (idx, dist) = exact_knn(to_array(&rows).view(), 3, &mut |_, _| {});
    assert_eq!((idx[[1, 0]], idx[[1, 1]]), (1, 0));
    assert_eq!(dist[[1, 0]], 0.0);
}

#[test]
fn f_7_knn_emits_progress_per_block() {
    let h = with(header(2000, 10, "umap"), json!({"epochs": 5}));
    let out = run_rows(&h, &gaussian_rows(2000, 10, 9));
    let knn: Vec<(u64, u64)> = out
        .of_type("progress")
        .iter()
        .filter(|p| p["stage"] == "knn")
        .map(|p| (p["done"].as_u64().unwrap(), p["total"].as_u64().unwrap()))
        .collect();
    assert!(knn.len() >= 2);
    assert!(knn.windows(2).all(|w| w[0].0 <= w[1].0));
    let last = knn.last().unwrap();
    assert_eq!(last.0, last.1);
}

#[test]
fn jacobi_matches_known_eigenpairs() {
    let (c, s) = (0.6f64, 0.8f64);
    let r = array![[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]];
    let d = array![[5.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 1.0]];
    let m = r.dot(&d).dot(&r.t());
    let (vals, vecs) = jacobi_eigh(m.view());
    for (got, want) in vals.iter().zip([5.0, 3.0, 1.0]) {
        assert!((got - want).abs() < 1e-9);
    }
    for col in 0..3 {
        let v = vecs.column(col);
        let dot: f64 = v.iter().zip(r.column(col)).map(|(a, b)| a * b).sum();
        assert!((dot.abs() - 1.0).abs() < 1e-9, "column {col}");
    }
}

#[test]
fn pca_fit_projects_fit_rows_with_same_basis() {
    let rows = to_array(&gaussian_rows(50, 6, 13));
    let basis = pca::fit(rows.view(), 3, 1);
    assert_eq!(basis.components.dim(), (3, 6));
    let proj = basis.project(rows.view());
    assert_eq!(proj.dim(), (50, 3));
    let var = |c: usize| proj.column(c).iter().map(|v| v * v).sum::<f32>();
    assert!(var(0) >= var(1) && var(1) >= var(2) && var(2) > 0.0);
    let centre = basis.project(basis.mean.view().insert_axis(ndarray::Axis(0)));
    assert!(centre.iter().all(|v| v.abs() < 1e-5));
}
