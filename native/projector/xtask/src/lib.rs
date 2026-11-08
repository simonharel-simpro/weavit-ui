//! Architectural linters for Rust CLI / MCP crates.
//!
//! These enforce the rules `clippy` cannot express on its own:
//! file length, domain-layer purity (import contracts), MCP stdout purity,
//! and test companions. Everything else (unwrap/expect/panic/unsafe/
//! complexity/unused-deps) is enforced by `clippy` `[lints]` + `cargo-deny`.
//!
//! Exposed as a library so the checks can be unit-tested against fixtures
//! (`tests/`), and driven as a binary via `cargo xtask lint`.

pub mod checks;
pub mod util;
