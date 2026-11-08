//! `cargo xtask lint` — run the architectural checks against a crate.
//!
//! Usage:
//!   cargo xtask lint               # scan ./src against ./Cargo.toml
//!   cargo xtask lint --root path   # scan a different crate root (used by tests/CI)

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.first().map(|a| a == "lint").unwrap_or(false) {
        eprintln!("usage: cargo xtask lint [--root <dir>]");
        return ExitCode::from(2);
    }
    let root = parse_root(&args);
    if xtask::checks::run_all(&root) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Resolve `--root <dir>`, defaulting to the current directory.
fn parse_root(args: &[String]) -> PathBuf {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--root" {
            if let Some(dir) = iter.next() {
                return PathBuf::from(dir);
            }
        }
    }
    PathBuf::from(".")
}
