//! File length limit. `clippy` has `too_many_lines` for functions but no
//! file-level limit, so this enforces the project's 200-line hard rule.

use super::Violation;
use crate::util;
use std::path::PathBuf;

// Rust-specific limit: more permissive than the 200-line house rule because
// one file is one module with its `#[cfg(test)]` tests inline. See rules/rust/patterns.md.
const FILE_LINE_LIMIT: usize = 400;

pub fn check(files: &[PathBuf]) -> Vec<Violation> {
    let mut violations = Vec::new();
    for file in files {
        let count = util::read(file).lines().count();
        if count > FILE_LINE_LIMIT {
            violations.push(Violation::new(
                file,
                1,
                format!(
                    "file is {count} lines (limit {FILE_LINE_LIMIT}) — split by responsibility"
                ),
            ));
        }
    }
    violations
}
