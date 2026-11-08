//! MCP stdout purity. In a stdio MCP server, stdout carries the JSON-RPC
//! stream — any stray write corrupts the protocol. This check activates only
//! when `rmcp` is a dependency (otherwise it SKIPs), and flags writes to
//! stdout anywhere in `src/`. (`clippy::print_stdout` is close but isn't
//! rmcp-aware and also flags legitimate CLI data output.)

use super::{CheckOutcome, Violation};
use crate::util;
use std::path::{Path, PathBuf};

const STDOUT_TOKENS: &[&str] = &["println!", "print!", "io::stdout", "stdout()"];

pub fn check(root: &Path, files: &[PathBuf]) -> CheckOutcome {
    if !cargo_has_rmcp(root) {
        return CheckOutcome::Skipped("no `rmcp` dependency — not an MCP server".into());
    }
    let mut violations = Vec::new();
    for file in files {
        let stripped = util::strip(&util::read(file));
        for (idx, line) in stripped.lines().enumerate() {
            scan_line(file, idx + 1, line, &mut violations);
        }
    }
    CheckOutcome::Checked(violations)
}

fn cargo_has_rmcp(root: &Path) -> bool {
    util::read(&root.join("Cargo.toml"))
        .lines()
        .any(|l| l.trim_start().starts_with("rmcp"))
}

fn scan_line(file: &Path, lineno: usize, line: &str, out: &mut Vec<Violation>) {
    for token in STDOUT_TOKENS {
        if line.contains(token) {
            out.push(Violation::new(
                file,
                lineno,
                format!(
                    "MCP stdio server must not write to stdout (`{token}`) — log to stderr/tracing"
                ),
            ));
        }
    }
}
