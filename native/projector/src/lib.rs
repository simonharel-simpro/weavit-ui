use std::io::{BufRead, Read, Write};

use input::RowReader;
use ndarray::{Array2, ArrayView2};
use protocol::{FrameStage, Header, Message, Method, Stage, encode_f32, write_message};
use stream::{PcaOutput, ensure_finite, stream_pca};

pub mod input;
pub mod knn;
pub mod pca;
pub mod protocol;
mod stream;
pub mod umap_run;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("header: {0}")]
    Header(String),
    #[error("input ended mid-row")]
    ShortRow,
    #[error("non-finite value in row {row}")]
    NonFinite { row: usize },
    #[error("more rows than nMax")]
    TooManyRows,
    #[error("no rows")]
    NoRows,
    #[error("pca: {0}")]
    Pca(String),
    #[error("umap: {0}")]
    Umap(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl RunError {
    /// 2 header error, 3 host gone (stdout broken pipe), 1 anything else.
    pub fn exit_code(&self) -> i32 {
        match self {
            RunError::Header(_) => 2,
            RunError::Io(e) if e.kind() == std::io::ErrorKind::BrokenPipe => 3,
            _ => 1,
        }
    }
}

const MAX_HEADER_BYTES: u64 = 64 * 1024;

/// Reads the header from `input`, then streams projections to `out` until `done`.
pub fn run(mut input: impl BufRead, mut out: impl Write) -> Result<(), RunError> {
    let header = read_header(&mut input)?;
    let mut reader = RowReader::new(input, header.dim, header.n_max);
    let pca = stream_pca(&mut reader, &header, &mut out)?;
    let coords: Vec<f32> = pca.proj.iter().copied().collect();
    ensure_finite(&coords, "pca50 coordinates")?;
    let msg = Message::Pca50 {
        n: pca.n,
        pca_dims: pca.proj.ncols(),
        coords: encode_f32(&coords),
    };
    write_message(&mut out, &msg)?;
    if header.method == Method::Umap {
        if pca.n > header.n_neighbors {
            umap_stage(&mut out, &header, &pca)?;
        } else {
            let message = format!(
                "UMAP needs at least {} points; PCA only",
                header.n_neighbors + 1
            );
            write_message(&mut out, &Message::Notice { message })?;
        }
    }
    Ok(write_message(&mut out, &Message::Done { n: pca.n })?)
}

fn read_header(input: &mut impl BufRead) -> Result<Header, RunError> {
    let mut line = String::new();
    input.by_ref().take(MAX_HEADER_BYTES).read_line(&mut line)?;
    if line.trim().is_empty() {
        return Err(RunError::Header("missing header line".to_owned()));
    }
    let header: Header =
        serde_json::from_str(&line).map_err(|e| RunError::Header(e.to_string()))?;
    header.validate()?;
    Ok(header)
}

fn umap_stage(out: &mut impl Write, h: &Header, pca: &PcaOutput) -> Result<(), RunError> {
    let (indices, dists) = knn_with_progress(out, h, pca)?;
    write_message(out, &progress(Stage::Graph, 0, 1))?;
    let mut graph_done = false;
    let on_frame = &mut |epoch: usize, coords: ArrayView2<f32>| {
        if !std::mem::replace(&mut graph_done, true) {
            write_message(out, &progress(Stage::Graph, 1, 1))?;
        }
        write_message(out, &progress(Stage::Epochs, epoch, h.epochs))?;
        let flat: Vec<f32> = coords.iter().copied().collect();
        let coords = encode_f32(&flat);
        let stage = FrameStage::Umap;
        let (epochs, dims, n) = (h.epochs, h.dims, pca.n);
        write_message(
            out,
            &Message::Frame {
                stage,
                epoch,
                epochs,
                dims,
                n,
                coords,
            },
        )
    };
    let knn = (indices.view(), dists.view());
    let (nn, dist, ep, fe) = (h.n_neighbors, h.min_dist, h.epochs, h.frame_every);
    umap_run::run_umap(pca.proj.view(), knn, h.dims, nn, dist, ep, fe, on_frame)
}

fn progress(stage: Stage, done: usize, total: usize) -> Message {
    Message::Progress { stage, done, total }
}

/// The kNN callback cannot fail, so the first write error is parked and returned afterwards.
fn knn_with_progress(
    out: &mut impl Write,
    h: &Header,
    pca: &PcaOutput,
) -> Result<(Array2<u32>, Array2<f32>), RunError> {
    let mut io_err: Option<std::io::Error> = None;
    let result = knn::exact_knn(pca.proj.view(), h.n_neighbors, &mut |done, total| {
        let written = write_message(out, &progress(Stage::Knn, done, total));
        if let (None, Err(e)) = (&io_err, written) {
            io_err = Some(e);
        }
    });
    io_err.map_or(Ok(result), |e| Err(e.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, ErrorKind};

    #[test]
    fn exit_codes_follow_the_protocol() {
        assert_eq!(RunError::Header("x".into()).exit_code(), 2);
        assert_eq!(RunError::Io(ErrorKind::BrokenPipe.into()).exit_code(), 3);
        assert_eq!(RunError::Io(ErrorKind::NotFound.into()).exit_code(), 1);
        assert_eq!(RunError::NoRows.exit_code(), 1);
    }

    #[test]
    fn run_streams_a_tiny_pca_job_to_done() {
        let header = r#"{"protocol":1,"nMax":3,"dim":2,"method":"pca","dims":2,"pcaDims":2,"nNeighbors":15,"minDist":0.1,"epochs":1,"seed":1,"frameEvery":1,"batchRows":2,"fitRows":2}"#;
        let mut input = format!("{header}\n").into_bytes();
        input.extend(
            [1.0f32, 2.0, 3.0, 5.0, 8.0, 13.0]
                .iter()
                .flat_map(|v| v.to_le_bytes()),
        );
        let mut out = Vec::new();
        run(Cursor::new(input), &mut out).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().last(), Some(r#"{"type":"done","n":3}"#));
    }

    #[test]
    fn run_rejects_an_empty_header() {
        let r = run(Cursor::new(Vec::new()), Vec::new());
        assert!(matches!(r, Err(RunError::Header(_))));
    }
}
