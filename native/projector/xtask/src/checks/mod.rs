//! The architectural checks and the runner that prints a coverage table.
//!
//! A `Skipped` outcome is shown as a SKIP row rather than a silent pass, so a
//! human can ask "why was this layer not scanned?" (e.g. the MCP check skips
//! when `rmcp` isn't a dependency).

pub mod companion;
pub mod file_length;
pub mod layer;
pub mod mcp;

use crate::util;
use std::path::{Path, PathBuf};

/// A single rule violation to report.
#[derive(Debug, Clone)]
pub struct Violation {
    pub file: PathBuf,
    pub line: usize,
    pub message: String,
}

impl Violation {
    pub fn new(file: &Path, line: usize, message: impl Into<String>) -> Self {
        Self {
            file: file.to_path_buf(),
            line,
            message: message.into(),
        }
    }
}

/// Outcome of a check that may legitimately not apply.
pub enum CheckOutcome {
    Skipped(String),
    Checked(Vec<Violation>),
}

/// Run every check against `root`, print results, return `true` if all passed.
pub fn run_all(root: &Path) -> bool {
    let files = util::walk_rs_files(&root.join("src"));
    println!(
        "Rust CLI/MCP architectural linters — scanned {} file(s)\n",
        files.len()
    );

    let mut ok = true;
    ok &= report("file-length", file_length::check(&files));
    ok &= report("layer-boundaries", layer::check(&files));
    ok &= report_outcome("mcp-stdout-purity", mcp::check(root, &files));
    ok &= report("test-companion", companion::check(root, &files));

    println!(
        "\n{}",
        if ok {
            "OK — all checks passed"
        } else {
            "FAIL — fix the violations above"
        }
    );
    ok
}

fn report(name: &str, violations: Vec<Violation>) -> bool {
    if violations.is_empty() {
        println!("  PASS  {name}");
        return true;
    }
    println!("  FAIL  {name} ({} violation(s)):", violations.len());
    for v in &violations {
        println!("        {}:{}: {}", v.file.display(), v.line, v.message);
    }
    false
}

fn report_outcome(name: &str, outcome: CheckOutcome) -> bool {
    match outcome {
        CheckOutcome::Skipped(reason) => {
            println!("  SKIP  {name} ({reason})");
            true
        }
        CheckOutcome::Checked(violations) => report(name, violations),
    }
}
