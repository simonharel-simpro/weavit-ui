import { describe, expect, it } from 'vitest'
import type { PropValue } from '@shared/types'
import { colorScale, OTHER_COLOR, scaleForLevel, toColorAttribute, type Rgb } from './colors'
import { roleColumn } from './defaults'

const isGrey = ([r, g, b]: number[]): boolean => r === g && g === b

function categorical(): PropValue[] {
  const values: PropValue[] = []
  for (let i = 1; i <= 11; i++) {
    const name = `c${String(i).padStart(2, '0')}`
    for (let k = 0; k < 21 - i; k++) values.push(name) // c01 x20 ... c11 x10
  }
  for (let k = 0; k < 5; k++) values.push('k')
  for (let k = 0; k < 5; k++) values.push('m')
  values.push('z')
  for (let k = 0; k < 3; k++) values.push(null)
  return values
}

describe('colorScale', () => {
  it('U-17: should bucket top-12 categories, then other, with missing separate', () => {
    const values = categorical()
    const scale = colorScale('text', values)
    const labels = scale.legend.map((l) => l.label)
    expect(labels).toEqual([
      'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'c10', 'c11', 'k', 'other', 'missing'
    ])
    expect(scale.legend.find((l) => l.label === 'other')?.count).toBe(6)
    expect(scale.legend.find((l) => l.label === 'missing')?.count).toBe(3)
    const at = (v: PropValue): number => values.indexOf(v)
    expect(scale.colorOf(at('m'))).toEqual(scale.colorOf(at('z')))
    expect(scale.colorOf(at('k'))).not.toEqual(scale.colorOf(at('m')))
    expect(scale.colorOf(at(null))).not.toEqual(scale.colorOf(at('m')))
    const again = colorScale('text', categorical())
    for (let i = 0; i < values.length; i++) expect(again.colorOf(i)).toEqual(scale.colorOf(i))
  })

  it('U-17: should ramp numerics with nulls grey', () => {
    const scale = colorScale('int', [0, 50, 100, null])
    expect(scale.colorOf(0)).not.toEqual(scale.colorOf(2))
    expect(isGrey(scale.colorOf(3))).toBe(true)
  })

  it('U-49: should give a constant or all-null numeric column a single colour', () => {
    const constant = colorScale('int', [5, 5, null])
    expect(constant.colorOf(0)).toEqual(constant.colorOf(1))
    expect(constant.colorOf(0).every(Number.isFinite)).toBe(true)
    expect(isGrey(constant.colorOf(2))).toBe(true)
    const empty = colorScale('int', [null, null])
    expect(empty.colorOf(0)).toEqual(empty.colorOf(1))
    expect(empty.colorOf(0).every(Number.isFinite)).toBe(true)
  })

  it('should pack n colours into an n x 3 byte attribute', () => {
    const scale = colorScale('int', [0, 100])
    const attr = toColorAttribute(scale, 2)
    expect(attr).toBeInstanceOf(Uint8Array)
    expect(Array.from(attr)).toEqual([...scale.colorOf(0), ...scale.colorOf(1)])
  })

  it('should give one colour when no property is chosen', () => {
    const scale = colorScale(undefined, [])
    expect(scale.colorOf(0)).toEqual(scale.colorOf(41))
    expect(scale.legend).toHaveLength(1)
  })
})

describe('inherited colours (drill-down)', () => {
  const RED: Rgb = [255, 0, 0]
  const BLUE: Rgb = [0, 0, 255]

  it("U-26: should inherit the root's category colours in a drill-down", () => {
    const root = new Map<string, Rgb>([['a', RED], ['b', BLUE]])
    const child = colorScale('text', ['b', 'c'], root)
    expect(child.colorOf(0)).toEqual(BLUE)
    expect(child.colorOf(1)).toEqual(OTHER_COLOR)
    expect(child.legend.map((l) => l.label)).toEqual(['b', 'other'])
  })

  it("U-39: should build root colour maps from the root run's points", () => {
    const rootPoints = pointsOf('L1', ['a', 'b', 'c', 'b'])
    const levelPoints = pointsOf('L2', ['b'])
    const rootCol = roleColumn(rootPoints, 'cat') ?? []
    const levelCol = roleColumn(levelPoints, 'cat') ?? []
    const root = colorScale('text', rootCol)
    expect([...(root.categories ?? new Map()).keys()].sort()).toEqual(['a', 'b', 'c'])
    const level = scaleForLevel('text', levelCol, rootCol)
    expect([...(level.categories ?? new Map()).keys()].sort()).toEqual(['a', 'b', 'c'])
    expect(level.colorOf(0)).toEqual(root.colorOf(1))
  })

  it('U-36: should keep root numeric colours in a drill-down', () => {
    const root = colorScale('int', [1990, 2000, 2020])
    const plain = colorScale('int', [2000, 2005, 2010])
    const inherited = colorScale('int', [2000, 2005, 2010], undefined, root.range)
    expect(root.range).toEqual({ min: 1990, max: 2020 })
    expect(plain.colorOf(0)).not.toEqual(root.colorOf(1))
    expect(inherited.colorOf(0)).toEqual(root.colorOf(1))
  })

  it('U-36: should clamp a value outside the inherited range to the ramp ends', () => {
    const root = colorScale('int', [1990, 1995, 2020])
    const wide = colorScale('int', [1900, 1995, 2100], undefined, root.range)
    expect(wide.colorOf(0)).toEqual(root.colorOf(0))
    expect(wide.colorOf(1)).toEqual(root.colorOf(1))
    expect(wide.colorOf(2)).toEqual(root.colorOf(2))
  })

  it('should fall back to the level own colours when the root column is unavailable', () => {
    const own = colorScale('text', ['x', 'y'])
    const level = scaleForLevel('text', ['x', 'y'], undefined)
    expect(level.colorOf(0)).toEqual(own.colorOf(0))
    expect(level.colorOf(1)).toEqual(own.colorOf(1))
  })
})

function pointsOf(runId: string, cat: PropValue[]): Parameters<typeof roleColumn>[0] {
  return { uuids: cat.map((_, i) => `u${i}`), props: ['cat'], columns: [cat], runId }
}
