// The single source of the embedding-projector constants: the main process and
// the renderer both import from here, so a bound can never differ between them.

export const MAX_ROWS = 100_000
/** n·d bound (D-8); the Rust sidecar enforces the same cap on its header. */
export const MAX_CELLS = 100_000 * 1024
export const NN_DEFAULT = 15
/** UMAP needs more points than neighbours. */
export const MIN_SELECTION = NN_DEFAULT + 1
/** Weaviate's offset limit (QUERY_MAXIMUM_RESULTS) caps a filtered read (D-10). */
export const FILTERED_MAX = 10_000
export const OVERLAY_K = { min: 1, max: 100, default: 20 } as const
export const LABEL_MAX_CHARS = 200
export const PAGE_SIZE = 1000

/**
 * Decodes the sidecar's base64 f32 arrays. The bytes are little-endian on the
 * wire whatever the host's byte order, hence DataView rather than a cast view.
 */
export function decodeF32(b64: string): Float32Array {
  const bin = atob(b64)
  if (bin.length % 4 !== 0) {
    throw new Error(`f32 payload of ${bin.length} bytes is not a multiple of 4`)
  }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  const out = new Float32Array(bin.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}
