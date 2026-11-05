// Pure deep-link parsing (web mode): `?collection=<Name>` opens that collection
// once auto-connect succeeds. No api/React imports, so the node tests can load it.

// Weaviate class names: an uppercase letter, then letters, digits or underscores.
const COLLECTION_NAME = /^[A-Z][_0-9A-Za-z]*$/

/** The collection named in the URL query, or undefined when absent or not a valid name. */
export function collectionFromSearch(search: string): string | undefined {
  const name = new URLSearchParams(search).get('collection')
  return name !== null && COLLECTION_NAME.test(name) ? name : undefined
}
