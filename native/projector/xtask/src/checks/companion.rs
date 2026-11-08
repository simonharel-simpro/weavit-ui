//! Test companion. Every module that exposes public functions must have tests:
//! either an inline `#[cfg(test)]` module, or an integration test file under
//! `tests/` whose name references the module. Modules with no public API are
//! exempt (nothing to test). `clippy` cannot check for missing tests.

use super::Violation;
use crate::util;
use std::path::{Path, PathBuf};

/// Entry-point files that don't need a test companion.
const EXEMPT_STEMS: &[&str] = &["main", "lib", "build"];

pub fn check(root: &Path, files: &[PathBuf]) -> Vec<Violation> {
    let mut violations = Vec::new();
    for file in files {
        if EXEMPT_STEMS.contains(&raw_stem(file).as_str()) {
            continue;
        }
        let stripped = util::strip(&util::read(file));
        if !has_public_fn(&stripped) || has_inline_tests(&stripped) {
            continue;
        }
        let name = module_name(file);
        if has_external_test(root, &name) {
            continue;
        }
        violations.push(Violation::new(
            file,
            1,
            format!("module `{name}` has public fn(s) but no tests (add #[cfg(test)] or tests/{name}*.rs)"),
        ));
    }
    violations
}

fn raw_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// Display name for a module: the file stem, or the parent dir for `mod.rs`.
fn module_name(path: &Path) -> String {
    let stem = raw_stem(path);
    if stem != "mod" {
        return stem;
    }
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("mod")
        .to_string()
}

fn has_public_fn(stripped: &str) -> bool {
    stripped.contains("pub fn ") || stripped.contains("pub async fn ")
}

fn has_inline_tests(stripped: &str) -> bool {
    stripped.contains("#[cfg(test)]")
}

fn has_external_test(root: &Path, stem: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(root.join("tests")) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_name()
            .to_str()
            .map(|n| n.contains(stem))
            .unwrap_or(false)
    })
}
