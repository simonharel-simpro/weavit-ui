// Headers the host adds to every Weaviate connection without storing them in a
// profile. Web mode uses it to pass a provider key from the environment
// (WEAVIT_OPENROUTER_API_KEY): it never lands on disk and never reaches the browser.

let extra: Record<string, string> = {}

export function setExtraHeaders(headers: Record<string, string>): void {
  extra = { ...headers }
}

/** The profile's own headers win over host-provided ones. */
export function mergedHeaders(own?: Record<string, string>): Record<string, string> | undefined {
  const merged = { ...extra, ...(own ?? {}) }
  return Object.keys(merged).length ? merged : undefined
}
