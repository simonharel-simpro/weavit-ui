//! Domain-layer purity (the import-contract / boundary check).
//!
//! Files under any `domain/` directory must stay pure: no I/O or framework
//! imports, no cross-layer imports, and no `print*!` macros. This is the Rust
//! equivalent of Python's import-linter forbidden contracts, which `clippy`
//! cannot express.

use super::Violation;
use crate::util;
use std::path::{Path, PathBuf};

/// Crates/paths a pure domain module must never import.
const FORBIDDEN_USES: &[&str] = &[
    "clap",
    "rmcp",
    "reqwest",
    "hyper",
    "axum",
    "tokio::net",
    "tokio::fs",
    "std::process",
    "std::io",
    "crate::cli",
    "crate::commands",
    "crate::tools",
    "crate::server",
];

const PRINT_MACROS: &[&str] = &["println!", "print!", "eprintln!", "eprint!"];

pub fn check(files: &[PathBuf]) -> Vec<Violation> {
    let mut violations = Vec::new();
    for file in files {
        if !is_domain(file) {
            continue;
        }
        let stripped = util::strip(&util::read(file));
        for (idx, line) in stripped.lines().enumerate() {
            scan_line(file, idx + 1, line, &mut violations);
        }
    }
    violations
}

fn is_domain(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "domain")
}

fn scan_line(file: &Path, lineno: usize, line: &str, out: &mut Vec<Violation>) {
    if line.trim_start().starts_with("use ") {
        for bad in FORBIDDEN_USES {
            if line.contains(bad) {
                out.push(Violation::new(
                    file,
                    lineno,
                    format!("domain layer must not import `{bad}` (keep domain pure)"),
                ));
            }
        }
    }
    for mac in PRINT_MACROS {
        if line.contains(mac) {
            out.push(Violation::new(
                file,
                lineno,
                format!("domain layer must not use `{mac}` — no I/O in domain"),
            ));
        }
    }
}
