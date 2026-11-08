import type { Layer } from '@deck.gl/core'
import { PointCloudLayer, ScatterplotLayer } from '@deck.gl/layers'

type Rgb = [number, number, number]
interface Binary {
  length: number
  attributes: Record<string, { value: Float32Array | Uint8Array; size: number }>
}

export interface LayerFrame {
  coords: Float32Array
  dims: 2 | 3
  n: number
  /** n×3 bytes. */
  colors: Uint8Array
}

const POINT_PX = 3
const HIGHLIGHT: Rgb = [255, 255, 255]
const MARKER: Rgb = [255, 64, 129]

/** Typed arrays end to end: no per-point JS objects. */
function pointLayer(id: string, dims: 2 | 3, data: Binary, px: number, pickable: boolean): Layer {
  return dims === 2
    ? new ScatterplotLayer({ id, data, pickable, radiusUnits: 'pixels', getRadius: px })
    : new PointCloudLayer({ id, data, pickable, pointSize: px, material: false })
}

function binary(dims: 2 | 3, positions: Float32Array, colors: Uint8Array, length: number): Binary {
  const colorName = dims === 2 ? 'getFillColor' : 'getColor'
  return {
    length,
    attributes: { getPosition: { value: positions, size: dims }, [colorName]: { value: colors, size: 3 } }
  }
}

function overlay(id: string, dims: 2 | 3, positions: number[], rgb: Rgb, px: number): Layer[] {
  const count = positions.length / dims
  if (count === 0) return []
  const colors = new Uint8Array(count * 3)
  for (let i = 0; i < count; i++) colors.set(rgb, i * 3)
  return [pointLayer(id, dims, binary(dims, new Float32Array(positions), colors, count), px, false)]
}

export function buildLayers(
  { coords, dims, n, colors }: LayerFrame,
  highlight: Set<number> | undefined,
  marker: number[] | undefined
): Layer[] {
  const picked = [...(highlight ?? [])].filter((i) => i >= 0 && i < n)
  const picks = picked.flatMap((i) => Array.from(coords.subarray(i * dims, i * dims + dims)))
  return [
    pointLayer(`points-${dims}d`, dims, binary(dims, coords, colors, n), POINT_PX, true),
    ...overlay(`highlight-${dims}d`, dims, picks, HIGHLIGHT, POINT_PX * 2.5),
    ...overlay(`marker-${dims}d`, dims, marker ?? [], MARKER, POINT_PX * 3)
  ]
}
