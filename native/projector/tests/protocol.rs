#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "integration tests may panic on failure"
)]

mod common;

use common::*;
use serde_json::{Value, json};
use weavit_projector::protocol::{
    FrameStage, Header, Message, PROTOCOL, encode_f32, write_message,
};

const INVALID: [&str; 17] = [
    "bad-json",
    "unknown-field",
    "protocol-2",
    "method-tsne",
    "dim-1",
    "dims-4",
    "nmax-0",
    "pca-dims-0",
    "neighbors-1",
    "min-dist-0",
    "min-dist-1.5",
    "epochs-0",
    "frame-every-0",
    "batch-rows-0",
    "fit-rows-0",
    "too-large",
    "non-finite",
];

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).expect("fixture exists")
}

#[test]
fn f_9_first_line_is_hello_with_protocol_version() {
    let out = run_bytes(Vec::new());
    assert_eq!(out.lines[0], json!({"type":"hello","protocol":1}));
}

#[test]
fn header_valid_fixture_parses() {
    let h: Header = serde_json::from_slice(&fixture("header.valid.json")).unwrap();
    assert_eq!((h.n_max, h.pca_dims, h.frame_every), (100_000, 50, 10));
    assert!(h.validate().is_ok());
}

#[test]
fn header_at_limit_is_accepted() {
    let h: Header = serde_json::from_slice(&fixture("header.valid.at-limit.json")).unwrap();
    assert_eq!(h.n_max * h.dim, 100_000 * 1024);
    assert!(h.validate().is_ok());
}

#[test]
fn header_rejections_from_fixtures() {
    for name in INVALID {
        let out = run_bytes(fixture(&format!("header.invalid.{name}.json")));
        assert_eq!(out.code, 2, "{name}: exit code");
        assert_eq!(out.last_type(), "error", "{name}: last line");
        assert_eq!(out.of_type("done").len(), 0, "{name}: no done");
    }
}

#[test]
fn message_fields_are_camel_case() {
    let pca50 = Message::Pca50 {
        n: 2,
        pca_dims: 3,
        coords: encode_f32(&[1.0]),
    };
    let frame = Message::Frame {
        stage: FrameStage::Umap,
        epoch: 10,
        epochs: 200,
        dims: 2,
        n: 1,
        coords: encode_f32(&[1.0]),
    };
    let a: Value = serde_json::to_value(&pca50).unwrap();
    let b: Value = serde_json::to_value(&frame).unwrap();
    assert_eq!(a["pcaDims"], 3);
    assert_eq!(b["epochs"], 200);
    assert_eq!(b["stage"], "umap");
    for v in [&a, &b] {
        assert!(v.as_object().unwrap().keys().all(|k| !k.contains('_')));
    }
}

#[test]
fn f_13_exits_when_stdin_closes_before_header() {
    let start = std::time::Instant::now();
    let out = run_bytes(Vec::new());
    assert!(start.elapsed().as_secs_f32() < 1.0);
    assert_eq!(out.lines[0]["type"], "hello");
    assert_eq!(out.last_type(), "error");
    assert_ne!(out.code, 0);
}

#[test]
fn f_13_broken_pipe_exits_3() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let mut child = Command::new(env!("CARGO_BIN_EXE_weavit-projector"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut first = String::new();
    stdout.read_line(&mut first).unwrap();
    drop(stdout);
    let mut stdin = child.stdin.take().unwrap();
    let rows = gaussian_rows(2_000, 8, 1);
    let mut payload = format!("{}\n", header(2_000, 8, "pca")).into_bytes();
    payload.extend(f32_bytes(&rows));
    let _ = stdin.write_all(&payload);
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(3));
    assert!(!String::from_utf8_lossy(&out.stderr).contains("panicked"));
}

#[test]
fn fixture_messages_round_trip() {
    let text = String::from_utf8(fixture("messages.ndjson")).unwrap();
    let lines: Vec<Value> = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let expected: Value = serde_json::from_slice(&fixture("messages.expected.json")).unwrap();
    assert_eq!(lines[0]["type"], "hello");
    assert_eq!(lines[0]["protocol"], PROTOCOL);
    let stages: Vec<&str> = lines
        .iter()
        .filter(|l| l["type"] == "progress")
        .map(|l| l["stage"].as_str().unwrap())
        .collect();
    assert_eq!(stages, ["pca", "knn", "graph", "epochs"]);
    let find = |ty: &str| lines.iter().find(|l| l["type"] == ty).unwrap();
    let nums = |v: &Value| -> Vec<f32> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap() as f32)
            .collect()
    };
    assert_eq!(
        decode(&find("basis")["mean"]),
        nums(&expected["basis"]["mean"])
    );
    assert_eq!(
        decode(&find("basis")["components"]),
        nums(&expected["basis"]["components"])
    );
    for ty in ["pcaChunk", "pca50", "frame"] {
        assert_eq!(
            decode(&find(ty)["coords"]),
            nums(&expected[ty]["coords"]),
            "{ty}"
        );
    }
    for ty in ["notice", "done", "error"] {
        find(ty);
    }
}

#[test]
fn write_message_ends_with_newline_and_round_trips() {
    let mut buf = Vec::new();
    write_message(&mut buf, &Message::Done { n: 7 }).unwrap();
    assert_eq!(buf, b"{\"type\":\"done\",\"n\":7}\n");
}
