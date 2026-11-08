import { describe, expect, it } from 'vitest'
import { pointsInPolygon, toScreenXY } from './lasso'
import { IDLE, reduceLasso, type LassoAction, type LassoState, type Xy } from './lassoState'

const run = (actions: LassoAction[]): LassoState => actions.reduce(reduceLasso, IDLE)
const square: Xy[] = [[0, 0], [100, 0], [100, 100], [0, 100]]
const pickInside = (path: Xy[]): number[] =>
  pointsInPolygon(Float32Array.from([50, 50, 150, 50, 10, 90]), 3, path)

describe('reduceLasso', () => {
  it('should pick from every queued move when release follows without a render in between', () => {
    // pointermove is a continuous event: a fast release sees moves the last render did not.
    const [first, ...rest] = square as [Xy, ...Xy[]]
    const s = run([
      { type: 'arm', on: true },
      { type: 'down', at: first },
      ...rest.map((at): LassoAction => ({ type: 'move', at })),
      { type: 'up', pick: pickInside }
    ])
    expect(s.picked).toEqual([0, 2])
    expect(s.drawing).toBe(false)
  })

  it('should ignore a release when no stroke is in progress', () => {
    const s = run([{ type: 'arm', on: true }, { type: 'up', pick: () => [1] }])
    expect(s.picked).toBeUndefined()
  })

  it('should drop moves shorter than the minimum step', () => {
    const s = run([{ type: 'down', at: [0, 0] }, { type: 'move', at: [1, 1] }])
    expect(s.path).toEqual([[0, 0]])
  })
})

describe('toScreenXY', () => {
  it('should map each point through the viewport projection', () => {
    const xy = toScreenXY(Float32Array.from([1, 2, 3, 4]), 2, ([x, y]) => [x * 10, y * 10 + 5])
    expect(Array.from(xy)).toEqual([10, 25, 30, 45])
  })
})
