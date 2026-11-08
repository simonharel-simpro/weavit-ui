//! Streaming PCA phase: fit on the first rows, then project everything as it arrives.

use std::io::{BufRead, Write};

use ndarray::{Array2, ArrayView2};

use crate::RunError;
use crate::input::RowReader;
use crate::pca::{self, Basis};
use crate::protocol::{Header, Message, Stage, encode_f32, write_message};

/// All rows projected on the PCA-p basis (n x p).
pub struct PcaOutput {
    pub n: usize,
    pub proj: Array2<f32>,
}

pub fn ensure_finite(values: &[f32], what: &str) -> Result<(), RunError> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err(RunError::Pca(format!("non-finite {what}")))
    }
}

/// First three components, zero-padded when p < 3 (row-major, n x 3).
fn display_coords(proj: ArrayView2<f32>) -> Vec<f32> {
    proj.outer_iter()
        .flat_map(|r| (0..3).map(move |c| r.get(c).copied().unwrap_or(0.0)))
        .collect()
}

pub fn stream_pca<R: BufRead>(
    reader: &mut RowReader<R>,
    h: &Header,
    out: &mut impl Write,
) -> Result<PcaOutput, RunError> {
    let fit_rows = read_fit_rows(reader, h)?;
    let n_fit = fit_rows.nrows();
    let p = h.pca_dims.min(n_fit.saturating_sub(1)).min(h.dim).max(1);
    let basis = pca::fit(fit_rows.view(), p, h.seed);
    emit_basis(out, &basis, p)?;
    let mut proj: Vec<f32> = Vec::new();
    let mut n = 0;
    let mut pending = Some(fit_rows);
    while let Some(batch) = pending
        .take()
        .map_or_else(|| reader.next_batch(h.batch_rows), |b| Ok(Some(b)))?
    {
        let part = basis.project(batch.view());
        emit_chunk(out, n, &part)?;
        proj.extend(part.iter());
        n += batch.nrows();
        write_message(
            out,
            &Message::Progress {
                stage: Stage::Pca,
                done: n,
                total: n,
            },
        )?;
    }
    let proj = Array2::from_shape_vec((n, p), proj).map_err(|e| RunError::Pca(e.to_string()))?;
    Ok(PcaOutput { n, proj })
}

fn read_fit_rows<R: BufRead>(
    reader: &mut RowReader<R>,
    h: &Header,
) -> Result<Array2<f32>, RunError> {
    let mut flat: Vec<f32> = Vec::new();
    let mut rows = 0;
    while rows < h.fit_rows {
        match reader.next_batch(h.batch_rows.min(h.fit_rows - rows))? {
            Some(b) => {
                rows += b.nrows();
                flat.extend(b.iter());
            }
            None => break,
        }
    }
    if rows == 0 {
        return Err(RunError::NoRows);
    }
    Array2::from_shape_vec((rows, h.dim), flat).map_err(|e| RunError::Pca(e.to_string()))
}

fn emit_basis(out: &mut impl Write, basis: &Basis, p: usize) -> Result<(), RunError> {
    let mean = basis.mean.to_vec();
    let components: Vec<f32> = basis.components.iter().copied().collect();
    ensure_finite(&mean, "basis mean")?;
    ensure_finite(&components, "basis components")?;
    let msg = Message::Basis {
        mean: encode_f32(&mean),
        components: encode_f32(&components),
        pca_dims: p,
    };
    Ok(write_message(out, &msg)?)
}

fn emit_chunk(out: &mut impl Write, offset: usize, part: &Array2<f32>) -> Result<(), RunError> {
    let coords = display_coords(part.view());
    ensure_finite(&coords, "pca coordinates")?;
    let msg = Message::PcaChunk {
        offset,
        count: part.nrows(),
        coords: encode_f32(&coords),
    };
    Ok(write_message(out, &msg)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::array;

    #[test]
    fn display_coords_pads_missing_columns() {
        let proj = array![[1.0f32], [2.0]];
        assert_eq!(display_coords(proj.view()), [1.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn display_coords_truncates_to_three() {
        let proj = array![[1.0f32, 2.0, 3.0, 4.0]];
        assert_eq!(display_coords(proj.view()), [1.0, 2.0, 3.0]);
    }

    #[test]
    fn non_finite_values_are_a_pca_error() {
        assert!(matches!(
            ensure_finite(&[1.0, f32::NAN], "x"),
            Err(RunError::Pca(_))
        ));
        assert!(ensure_finite(&[1.0, 2.0], "x").is_ok());
    }
}
