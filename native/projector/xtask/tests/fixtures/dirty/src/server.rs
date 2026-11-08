//! MCP server module that wrongly writes to stdout.

/// Public fn, no tests → companion violation; stdout write → mcp violation.
pub fn start() {
    println!("server starting"); // VIOLATION: stdout write in an rmcp server
}
