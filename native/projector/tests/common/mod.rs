//! Shared helpers: drive the real binary and decode its NDJSON output.
#![allow(dead_code, reason = "each test crate uses a different subset")]

use std::io::Write;
use std::process::{Command, Stdio};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rand::SeedableRng;
use rand::rngs::StdRng;
use rand_distr::{Distribution, Normal};
use serde_json::{Value, json};

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/protocol-v1");

pub struct Output {
    pub lines: Vec<Value>,
    pub code: i32,
    pub stderr: String,
}

impl Output {
    pub fn of_type(&self, ty: &str) -> Vec<&Value> {
        self.lines.iter().filter(|l| l["type"] == ty).collect()
    }

    pub fn one(&self, ty: &str) -> &Value {
        let all = self.of_type(ty);
        assert_eq!(all.len(), 1, "expected exactly one {ty} line");
        all[0]
    }

    pub fn last_type(&self) -> &str {
        self.lines
            .last()
            .and_then(|l| l["type"].as_str())
            .unwrap_or("")
    }

    pub fn error_message(&self) -> String {
        self.one("error")["message"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    }
}

pub fn header(n_max: usize, dim: usize, method: &str) -> Value {
    json!({"protocol":1,"nMax":n_max,"dim":dim,"method":method,"dims":3,"pcaDims":50,
           "nNeighbors":15,"minDist":0.1,"epochs":200,"seed":42,"frameEvery":10,
           "batchRows":1000,"fitRows":10000})
}

pub fn f32_bytes(rows: &[Vec<f32>]) -> Vec<u8> {
    rows.iter()
        .flatten()
        .flat_map(|v| v.to_le_bytes())
        .collect()
}

/// Spawn the binary, feed `stdin` from a thread (no pipe deadlock), collect everything.
pub fn run_bytes(stdin: Vec<u8>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_weavit-projector"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn binary");
    let mut pipe = child.stdin.take().expect("stdin pipe");
    let feeder = std::thread::spawn(move || {
        let _ = pipe.write_all(&stdin);
    });
    let out = child.wait_with_output().expect("wait");
    let _ = feeder.join();
    let lines = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).expect("stdout line is JSON"))
        .collect();
    Output {
        lines,
        code: out.status.code().unwrap_or(-1),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

pub fn run_rows(h: &Value, rows: &[Vec<f32>]) -> Output {
    let mut stdin = format!("{h}\n").into_bytes();
    stdin.extend(f32_bytes(rows));
    run_bytes(stdin)
}

pub fn decode(v: &Value) -> Vec<f32> {
    let bytes = STANDARD
        .decode(v.as_str().expect("b64 string"))
        .expect("valid b64");
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn gaussian_rows(n: usize, dim: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut rng = StdRng::seed_from_u64(seed);
    let normal = Normal::new(0.0f32, 1.0).expect("valid normal");
    (0..n)
        .map(|_| (0..dim).map(|_| normal.sample(&mut rng)).collect())
        .collect()
}

/// `k` clusters of `per` rows each, centres 20 apart along distinct axes, unit noise.
pub fn clusters(k: usize, per: usize, dim: usize, seed: u64) -> Vec<Vec<f32>> {
    let mut rows = gaussian_rows(k * per, dim, seed);
    for (i, row) in rows.iter_mut().enumerate() {
        row[(i / per) % dim] += 20.0;
    }
    rows
}
