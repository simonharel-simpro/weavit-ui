#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "integration tests may panic on failure"
)]

mod common;

use common::*;
use serde_json::{Value, json};

fn umap_header(n: usize, dim: usize, epochs: u64, every: u64, dims: u64) -> Value {
    let mut h = header(n, dim, "umap");
    h["epochs"] = json!(epochs);
    h["frameEvery"] = json!(every);
    h["dims"] = json!(dims);
    h
}

fn frame_epochs(out: &Output) -> Vec<u64> {
    out.of_type("frame")
        .iter()
        .map(|f| f["epoch"].as_u64().unwrap())
        .collect()
}

#[test]
fn umap_frames_every_k_epochs() {
    let out = run_rows(&umap_header(600, 10, 30, 10, 2), &clusters(3, 200, 10, 5));
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(frame_epochs(&out), [10, 20, 30]);
    for f in out.of_type("frame") {
        let coords = decode(&f["coords"]);
        assert_eq!(coords.len(), 600 * 2);
        assert!(coords.iter().all(|v| v.is_finite()));
    }
}

#[test]
fn umap_last_step_is_clamped() {
    let out = run_rows(&umap_header(600, 10, 25, 10, 2), &clusters(3, 200, 10, 5));
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(frame_epochs(&out), [10, 20, 25]);
}

#[test]
fn umap_separates_clusters() {
    let out = run_rows(&umap_header(600, 10, 200, 100, 2), &clusters(3, 200, 10, 5));
    assert_eq!(out.code, 0, "{}", out.stderr);
    let frames = out.of_type("frame");
    let c = decode(&frames.last().unwrap()["coords"]);
    let pt = |i: usize| (c[i * 2] as f64, c[i * 2 + 1] as f64);
    let centroid: Vec<(f64, f64)> = (0..3)
        .map(|k| {
            let s = (k * 200..(k + 1) * 200)
                .map(pt)
                .fold((0.0, 0.0), |a, p| (a.0 + p.0, a.1 + p.1));
            (s.0 / 200.0, s.1 / 200.0)
        })
        .collect();
    let dist = |a: (f64, f64), b: (f64, f64)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
    let intra = (0..600)
        .map(|i| dist(pt(i), centroid[i / 200]))
        .sum::<f64>()
        / 600.0;
    let inter = (dist(centroid[0], centroid[1])
        + dist(centroid[0], centroid[2])
        + dist(centroid[1], centroid[2]))
        / 3.0;
    assert!(intra < 0.5 * inter, "intra {intra} inter {inter}");
}

#[test]
fn f_11_half_duplicate_rows_produce_finite_umap_coords() {
    let mut rows = gaussian_rows(2000, 10, 17);
    for r in rows.iter_mut().take(1000) {
        *r = vec![0.5; 10];
    }
    let out = run_rows(&umap_header(2000, 10, 20, 10, 2), &rows);
    for f in out.of_type("frame") {
        assert!(decode(&f["coords"]).iter().all(|v| v.is_finite()));
    }
    if out.code != 0 {
        assert!(
            out.error_message().contains("umap"),
            "{}",
            out.error_message()
        );
    }
}

#[test]
fn f_18_n_below_neighbors_yields_pca_only() {
    let out = run_rows(&umap_header(10, 6, 20, 10, 2), &gaussian_rows(10, 6, 1));
    assert_eq!(out.code, 0);
    assert_eq!(out.of_type("notice").len(), 1);
    assert_eq!(out.of_type("pca50").len(), 1);
    assert_eq!(out.one("done")["n"], 10);
    assert!(out.of_type("frame").is_empty());
}

#[test]
fn f_18_n_equal_neighbors_yields_pca_only() {
    let out = run_rows(&umap_header(15, 6, 20, 10, 2), &gaussian_rows(15, 6, 1));
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert_eq!(out.of_type("notice").len(), 1);
    assert_eq!(out.one("done")["n"], 15);
    assert!(out.of_type("frame").is_empty());
}
