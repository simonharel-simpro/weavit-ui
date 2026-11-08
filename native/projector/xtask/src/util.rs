//! Filesystem walking and a best-effort comment/string stripper.
//!
//! The stripper blanks out line comments, (nested) block comments, string
//! literals (normal + raw), and char literals — replacing them with spaces
//! while preserving newlines, so line numbers stay accurate. This prevents a
//! token like `println!` inside a comment or string from causing a false
//! positive. It is intentionally lightweight, not a full Rust lexer.

use std::fs;
use std::path::{Path, PathBuf};

/// Recursively collect `*.rs` files under `dir`, skipping `target/` and `.git/`.
pub fn walk_rs_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect(dir, &mut out);
    out.sort();
    out
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if name != "target" && name != ".git" {
                collect(&path, out);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/// Read a file to a string; returns empty on any error (the caller then skips it).
pub fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// Blank out comments and string/char literals, preserving newlines.
pub fn strip(src: &str) -> String {
    let b = src.as_bytes();
    let mut out: Vec<u8> = b
        .iter()
        .map(|&c| if c == b'\n' { b'\n' } else { b' ' })
        .collect();
    let mut i = 0;
    while i < b.len() {
        i = step(b, i, &mut out);
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Advance one token's worth from `i`; copy code bytes into `out`, skip the rest.
fn step(b: &[u8], i: usize, out: &mut [u8]) -> usize {
    let c = b[i];
    match () {
        _ if c == b'/' && peek(b, i + 1) == b'/' => skip_line_comment(b, i),
        _ if c == b'/' && peek(b, i + 1) == b'*' => skip_block_comment(b, i),
        _ if c == b'r' && is_raw_start(b, i) => skip_raw_string(b, i),
        _ if c == b'"' => skip_string(b, i),
        _ if c == b'\'' && is_char_literal(b, i) => skip_char_literal(b, i),
        _ => {
            out[i] = c;
            i + 1
        }
    }
}

fn peek(b: &[u8], i: usize) -> u8 {
    if i < b.len() {
        b[i]
    } else {
        0
    }
}

fn skip_line_comment(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i] != b'\n' {
        i += 1;
    }
    i
}

fn skip_block_comment(b: &[u8], mut i: usize) -> usize {
    let mut depth = 0usize;
    while i < b.len() {
        if b[i] == b'/' && peek(b, i + 1) == b'*' {
            depth += 1;
            i += 2;
        } else if b[i] == b'*' && peek(b, i + 1) == b'/' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                break;
            }
        } else {
            i += 1;
        }
    }
    i
}

fn skip_string(b: &[u8], mut i: usize) -> usize {
    i += 1; // opening quote
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    i
}

/// A raw-string prefix: `r"`, `r#"`, ... optionally with a `b` byte prefix.
fn is_raw_start(b: &[u8], i: usize) -> bool {
    let prev_ok = i == 0 || !is_ident(b[i - 1]) || b[i - 1] == b'b';
    let next = peek(b, i + 1);
    prev_ok && (next == b'"' || next == b'#')
}

fn skip_raw_string(b: &[u8], mut i: usize) -> usize {
    i += 1; // past 'r'
    let mut hashes = 0;
    while i < b.len() && b[i] == b'#' {
        hashes += 1;
        i += 1;
    }
    if peek(b, i) != b'"' {
        return i;
    }
    i += 1;
    skip_to_raw_close(b, i, hashes)
}

fn skip_to_raw_close(b: &[u8], mut i: usize, hashes: usize) -> usize {
    while i < b.len() {
        if b[i] == b'"' && raw_close_matches(b, i + 1, hashes) {
            return i + 1 + hashes;
        }
        i += 1;
    }
    i
}

fn raw_close_matches(b: &[u8], start: usize, hashes: usize) -> bool {
    (0..hashes).all(|k| peek(b, start + k) == b'#')
}

/// `'x'` or `'\n'` — but NOT a lifetime like `'a` (no closing quote).
fn is_char_literal(b: &[u8], i: usize) -> bool {
    peek(b, i + 1) == b'\\' || peek(b, i + 2) == b'\''
}

fn skip_char_literal(b: &[u8], mut i: usize) -> usize {
    i += 1; // opening quote
    if peek(b, i) == b'\\' {
        i += 2;
    } else {
        i += 1;
    }
    if peek(b, i) == b'\'' {
        i += 1;
    }
    i
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}
