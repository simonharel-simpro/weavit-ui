//! Pure domain module: no I/O, no framework imports, has tests. Clean.

/// Build a greeting. Note the string literal contains `println!` and `use clap`
/// to prove the stripper ignores tokens inside string/comment regions.
pub fn greeting(name: &str) -> String {
    // This comment mentions clap and println! but must not trip the linter.
    format!("hello, {name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greeting_includes_name() {
        assert_eq!(greeting("rust"), "hello, rust");
    }
}
