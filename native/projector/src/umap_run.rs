//! UMAP over a precomputed kNN graph, stepped in frames.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};

use ndarray::{Array2, ArrayView2};
use umap_rs::{
    EuclideanMetric, GraphParams, ManifoldParams, Metric, OptimizationParams, Optimizer, Umap,
    UmapConfig,
};

use crate::RunError;

const INIT_MAX_ABS: f32 = 10.0;

/// umap-rs 0.4.5 applies the "move other" half of each attraction step to a per-call copy
/// of the embedding that is then discarded, so attraction is half of umap-learn's while
/// repulsion is not. Halving the repulsion restores the balance; with the default 1.0 the
/// clusters of a clean 3-blob input stay smeared (kNN purity 0.64 instead of ~1.0).
const REPULSION_STRENGTH: f32 = 0.5;

/// Runs UMAP and calls `on_frame(epoch, coords)` every `frame_every` epochs and at the end.
#[allow(clippy::too_many_arguments, reason = "signature fixed by the plan")]
pub fn run_umap(
    pca: ArrayView2<f32>,
    knn: (ArrayView2<u32>, ArrayView2<f32>),
    dims: usize,
    n_neighbors: usize,
    min_dist: f32,
    epochs: usize,
    frame_every: usize,
    on_frame: &mut dyn FnMut(usize, ArrayView2<f32>) -> std::io::Result<()>,
) -> Result<(), RunError> {
    let cfg = build_config(dims, n_neighbors, min_dist, epochs);
    let umap = Umap::new(cfg.clone());
    let manifold = guarded(|| umap.learn_manifold(pca, knn.0, knn.1))?;
    let init = scaled_init(pca, dims);
    let metric_type = EuclideanMetric.metric_type();
    let mut opt = guarded(|| Optimizer::new(manifold, init, epochs, &cfg, metric_type))?;
    while opt.remaining_epochs() > 0 {
        let step = frame_every.min(opt.remaining_epochs());
        guarded(|| opt.step_epochs(step, &EuclideanMetric))?;
        let frame = opt.embedding();
        if frame.iter().any(|v| !v.is_finite()) {
            return Err(RunError::Umap("non-finite coordinate in frame".to_owned()));
        }
        on_frame(opt.current_epoch(), frame)?;
    }
    Ok(())
}

fn build_config(dims: usize, n_neighbors: usize, min_dist: f32, epochs: usize) -> UmapConfig {
    UmapConfig {
        n_components: dims,
        manifold: ManifoldParams {
            min_dist,
            ..ManifoldParams::default()
        },
        graph: GraphParams {
            n_neighbors,
            ..GraphParams::default()
        },
        optimization: OptimizationParams {
            n_epochs: Some(epochs),
            repulsion_strength: REPULSION_STRENGTH,
            ..OptimizationParams::default()
        },
    }
}

/// umap-rs panics on invalid input; turn that into an error instead of an abort.
fn guarded<T>(f: impl FnOnce() -> T) -> Result<T, RunError> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|p| RunError::Umap(panic_message(p.as_ref())))
}

fn panic_message(p: &(dyn Any + Send)) -> String {
    p.downcast_ref::<String>()
        .cloned()
        .or_else(|| p.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_else(|| "panic".to_owned())
}

/// PCA components 0..dims (zero-padded) scaled to max-abs 10; unscaled when all zero.
fn scaled_init(pca: ArrayView2<f32>, dims: usize) -> Array2<f32> {
    let mut init = Array2::<f32>::zeros((pca.nrows(), dims));
    for (src, mut dst) in pca
        .axis_iter(ndarray::Axis(1))
        .zip(init.axis_iter_mut(ndarray::Axis(1)))
    {
        dst.assign(&src);
    }
    let max_abs = init.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if max_abs > 0.0 {
        init *= INIT_MAX_ABS / max_abs;
    }
    init
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::array;

    #[test]
    fn init_is_scaled_to_ten_and_padded() {
        let pca = array![[1.0f32], [-2.0]];
        let init = scaled_init(pca.view(), 2);
        assert_eq!(init, array![[5.0f32, 0.0], [-10.0, 0.0]]);
    }

    #[test]
    fn all_zero_init_is_left_alone() {
        let init = scaled_init(Array2::<f32>::zeros((3, 2)).view(), 2);
        assert!(init.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_umap_panic_becomes_an_error() {
        let pca = Array2::<f32>::zeros((3, 2));
        let idx = Array2::<u32>::zeros((3, 15));
        let dst = Array2::<f32>::zeros((3, 15));
        let r = run_umap(
            pca.view(),
            (idx.view(), dst.view()),
            2,
            15,
            0.1,
            10,
            5,
            &mut |_, _| Ok(()),
        );
        assert!(matches!(r, Err(RunError::Umap(_))));
    }
}
