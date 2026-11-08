//! Verifies the checks against the clean/dirty fixtures.
//! Run with: cargo test   (from the xtask crate root)

use std::path::Path;
use xtask::checks::{companion, file_length, layer, mcp, CheckOutcome};
use xtask::util;

fn files(root: &Path) -> Vec<std::path::PathBuf> {
    util::walk_rs_files(&root.join("src"))
}

#[test]
fn clean_fixture_passes_every_check() {
    let root = Path::new("tests/fixtures/clean");
    let fs = files(root);

    assert!(
        file_length::check(&fs).is_empty(),
        "file-length should pass"
    );
    assert!(layer::check(&fs).is_empty(), "domain is pure");
    assert!(
        companion::check(root, &fs).is_empty(),
        "domain has inline tests"
    );
    assert!(
        matches!(mcp::check(root, &fs), CheckOutcome::Skipped(_)),
        "no rmcp dependency → mcp check must SKIP"
    );
}

#[test]
fn dirty_fixture_is_caught_by_every_check() {
    let root = Path::new("tests/fixtures/dirty");
    let fs = files(root);

    // domain imports clap AND uses println! → at least 2 boundary violations.
    let layer_v = layer::check(&fs);
    assert!(
        layer_v.len() >= 2,
        "expected domain boundary violations, got {layer_v:?}"
    );

    // server.rs and domain/mod.rs have public fns without tests.
    assert!(
        !companion::check(root, &fs).is_empty(),
        "expected companion violations"
    );

    // rmcp is a dependency → mcp check runs and finds the stdout writes.
    match mcp::check(root, &fs) {
        CheckOutcome::Checked(v) => assert!(!v.is_empty(), "expected stdout violations"),
        CheckOutcome::Skipped(r) => panic!("mcp check should run with rmcp present, skipped: {r}"),
    }
}
