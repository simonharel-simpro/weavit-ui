import type { PropValue } from '@shared/types'

export type Rgb = [number, number, number]
export interface LegendEntry {
  label: string
  color: Rgb
  count?: number
}
export interface NumericRange {
  min: number
  max: number
}
export interface ColorScale {
  colorOf(i: number): Rgb
  legend: LegendEntry[]
  /** Category → colour, so the root level can hand it down to a drill-down (U-26). */
  categories?: Map<string, Rgb>
  /** The numeric ramp's domain, handed down as `inheritedRange` (U-36). */
  range?: NumericRange
}

const MAX_NAMED = 12
export const MISSING_COLOR: Rgb = [120, 120, 120]
export const OTHER_COLOR: Rgb = [176, 150, 200]
const SINGLE_COLOR: Rgb = [77, 171, 247]
const PALETTE: Rgb[] = [
  [77, 171, 247], [255, 146, 43], [81, 207, 102], [250, 82, 82], [151, 117, 250], [34, 184, 207],
  [252, 196, 25], [240, 101, 149], [148, 216, 45], [116, 143, 252], [255, 107, 107], [32, 201, 151]
]
const RAMP: Rgb[] = [[68, 1, 84], [33, 145, 140], [253, 231, 37]]

function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((k) => Math.round((a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * t)) as Rgb
}

/** t in [0,1] across the three-stop ramp. */
function ramp(t: number): Rgb {
  const [a, b, c] = RAMP as [Rgb, Rgb, Rgb]
  return t < 0.5 ? lerp(a, b, t * 2) : lerp(b, c, (t - 0.5) * 2)
}

function single(count?: number): ColorScale {
  return { colorOf: () => SINGLE_COLOR, legend: [{ label: 'all points', color: SINGLE_COLOR, count }] }
}

function categorical(values: PropValue[], inherited?: Map<string, Rgb>): ColorScale {
  const counts = new Map<string, number>()
  let missing = 0
  for (const v of values) {
    if (v === null || v === undefined) missing++
    else counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
  }
  // Ties by value ascending keep the bucketing deterministic (U-17).
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  // A drill-down keeps the root's colours: only categories the root named are legend entries.
  const named = inherited ? ranked.filter(([k]) => inherited.has(k)) : ranked.slice(0, MAX_NAMED)
  const colours = inherited ?? new Map(named.map(([k], i) => [k, PALETTE[i % PALETTE.length] as Rgb]))
  const namedKeys = new Set(named.map(([k]) => k))
  const otherCount = ranked.filter(([k]) => !namedKeys.has(k)).reduce((s, [, c]) => s + c, 0)
  const legend: LegendEntry[] = named.map(([k, c]) => ({ label: k, color: colours.get(k) as Rgb, count: c }))
  if (otherCount > 0) legend.push({ label: 'other', color: OTHER_COLOR, count: otherCount })
  if (missing > 0) legend.push({ label: 'missing', color: MISSING_COLOR, count: missing })
  return {
    colorOf(i) {
      const v = values[i]
      if (v === null || v === undefined) return MISSING_COLOR
      return colours.get(String(v)) ?? OTHER_COLOR
    },
    legend,
    categories: colours
  }
}

function sequential(values: PropValue[], inheritedRange?: NumericRange): ColorScale {
  let min = inheritedRange?.min ?? Infinity
  let max = inheritedRange?.max ?? -Infinity
  if (!inheritedRange) {
    for (const v of values) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  // All null or a constant column: one colour, never a division by zero (U-49).
  const flat = !(max > min)
  const t = (v: number): number => (flat ? 0.5 : Math.min(1, Math.max(0, (v - min) / (max - min))))
  const legend: LegendEntry[] = flat
    ? [{ label: Number.isFinite(min) ? String(min) : 'no values', color: ramp(0.5) }]
    : [{ label: String(min), color: ramp(0) }, { label: String(max), color: ramp(1) }]
  return {
    colorOf(i) {
      const v = values[i]
      return typeof v === 'number' && Number.isFinite(v) ? ramp(t(v)) : MISSING_COLOR
    },
    legend: [...legend, { label: 'missing', color: MISSING_COLOR }],
    ...(Number.isFinite(min) && Number.isFinite(max) && { range: { min, max } })
  }
}

/** `dataType` is `scalarType(prop)` from the schema, never sniffed from the values. */
export function colorScale(
  dataType: string | undefined,
  values: PropValue[],
  inherited?: Map<string, Rgb>,
  inheritedRange?: NumericRange
): ColorScale {
  if (dataType === 'text' || dataType === 'boolean') return categorical(values, inherited)
  if (dataType === 'int' || dataType === 'number') return sequential(values, inheritedRange)
  return single()
}

/**
 * A drill-down level coloured with the root's maps (U-26, U-36). `rootValues` is the root run's
 * prefetched column (U-39); without it (not fetched yet) the level uses its own scale.
 */
export function scaleForLevel(
  dataType: string | undefined,
  values: PropValue[],
  rootValues: PropValue[] | undefined
): ColorScale {
  if (!rootValues) return colorScale(dataType, values)
  const root = colorScale(dataType, rootValues)
  return colorScale(dataType, values, root.categories, root.range)
}

export function toColorAttribute(scale: ColorScale, n: number): Uint8Array {
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) out.set(scale.colorOf(i), i * 3)
  return out
}
