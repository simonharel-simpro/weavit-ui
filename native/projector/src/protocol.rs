//! Wire protocol v1: the stdin header and the stdout NDJSON messages.

use std::io::Write;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::RunError;

pub const PROTOCOL: u32 = 1;

/// `minDist` may not exceed umap-rs's default `spread` (1.0), which we never change.
const MAX_MIN_DIST: f32 = 1.0;

/// Upper bound on `nMax * dim` (f32 cells) a header may request.
pub const MAX_CELLS: usize = 100_000 * 1024;

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Pca,
    Umap,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub protocol: u32,
    pub n_max: usize,
    pub dim: usize,
    pub method: Method,
    pub dims: usize,
    pub pca_dims: usize,
    pub n_neighbors: usize,
    pub min_dist: f32,
    pub epochs: usize,
    pub seed: u64,
    pub frame_every: usize,
    pub batch_rows: usize,
    pub fit_rows: usize,
}

impl Header {
    /// Applies every header rejection rule of protocol v1.
    pub fn validate(&self) -> Result<(), RunError> {
        let checks = [
            (self.protocol != PROTOCOL, "unsupported protocol"),
            (self.dim < 2, "dim must be >= 2"),
            (!(2..=3).contains(&self.dims), "dims must be 2 or 3"),
            (self.n_max < 1, "nMax must be >= 1"),
            (self.pca_dims < 1, "pcaDims must be >= 1"),
            (self.n_neighbors < 2, "nNeighbors must be >= 2"),
            (
                !self.min_dist.is_finite() || self.min_dist <= 0.0 || self.min_dist > MAX_MIN_DIST,
                "minDist must be in (0, 1]",
            ),
            (self.epochs < 1, "epochs must be >= 1"),
            (self.frame_every < 1, "frameEvery must be >= 1"),
            (self.batch_rows < 1, "batchRows must be >= 1"),
            (self.fit_rows < 1, "fitRows must be >= 1"),
            (
                self.n_max
                    .checked_mul(self.dim)
                    .is_none_or(|c| c > MAX_CELLS),
                "nMax * dim exceeds the cap",
            ),
        ];
        match checks.iter().find(|(bad, _)| *bad) {
            Some((_, why)) => Err(RunError::Header((*why).to_owned())),
            None => Ok(()),
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Pca,
    Knn,
    Graph,
    Epochs,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FrameStage {
    Umap,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Message {
    #[serde(rename_all = "camelCase")]
    Hello { protocol: u32 },
    #[serde(rename_all = "camelCase")]
    Progress {
        stage: Stage,
        done: usize,
        total: usize,
    },
    #[serde(rename_all = "camelCase")]
    Basis {
        mean: String,
        components: String,
        pca_dims: usize,
    },
    #[serde(rename_all = "camelCase")]
    PcaChunk {
        offset: usize,
        count: usize,
        coords: String,
    },
    #[serde(rename_all = "camelCase")]
    Pca50 {
        n: usize,
        pca_dims: usize,
        coords: String,
    },
    #[serde(rename_all = "camelCase")]
    Notice { message: String },
    #[serde(rename_all = "camelCase")]
    Frame {
        stage: FrameStage,
        epoch: usize,
        epochs: usize,
        dims: usize,
        n: usize,
        coords: String,
    },
    #[serde(rename_all = "camelCase")]
    Done { n: usize },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

/// Little-endian f32 bytes, standard base64.
pub fn encode_f32(values: &[f32]) -> String {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    STANDARD.encode(bytes)
}

/// One `write_all` of `json + '\n'`, then a flush so the host sees it promptly.
pub fn write_message(out: &mut impl Write, m: &Message) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(m).map_err(std::io::Error::other)?;
    line.push(b'\n');
    out.write_all(&line)?;
    out.flush()
}
