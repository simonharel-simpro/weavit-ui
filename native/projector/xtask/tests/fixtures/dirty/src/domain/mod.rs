//! IMPURE domain module — violates the boundary rules on purpose.

use clap::Parser; // VIOLATION: framework import in domain

/// Public fn with no #[cfg(test)] and no tests/ companion → companion violation.
pub fn compute(x: i64) -> i64 {
    println!("computing {x}"); // VIOLATION: I/O (and stdout) in domain
    x * 2
}
