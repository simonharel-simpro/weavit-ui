import { describe, expect, it } from 'vitest'
import { canSelect, canSelectLevel, pointsInPolygon, toRootIndices } from './lasso'
import { knownOf } from './status.fixtures'

const flat = (pts: [number, number][]): Float32Array => Float32Array.from(pts.flat())

describe('pointsInPolygon', () => {
  it('lasso: points inside a square', () => {
    const square: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    const xy = flat([[0.5, 0.5], [2, 0.5], [0.1, 0.9], [-1, 0.5], [0.9, 0.1]])
    expect(pointsInPolygon(xy, 5, square)).toEqual([0, 2, 4])
  })

  it('lasso: point on a concave polygon notch is outside', () => {
    // A U opening upward: the notch is x in (1, 2), y in (1, 3).
    const u: [number, number][] = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]]
    const xy = flat([[1.5, 2], [0.5, 2], [2.5, 2], [1.5, 0.5]])
    expect(pointsInPolygon(xy, 4, u)).toEqual([1, 2, 3])
  })

  it('should select nothing for a polygon with fewer than 3 vertices', () => {
    expect(pointsInPolygon(flat([[0, 0]]), 1, [[0, 0], [1, 1]])).toEqual([])
  })
})

describe('toRootIndices', () => {
  it('U-14: should map level-2 lasso indices to root indices', () => {
    expect(toRootIndices([0, 2], [10, 20, 30])).toEqual([10, 30])
  })

  it('should be the identity at the root level', () => {
    expect(toRootIndices([4, 1, 7])).toEqual([4, 1, 7])
  })

  it('should reject an index outside the level instead of inventing a root index', () => {
    expect(() => toRootIndices([3], [10, 20, 30])).toThrow(/outside/)
  })
})

describe('canSelect', () => {
  it('U-30: should block selection after a cancelled read', () => {
    const cancelled = knownOf({ state: 'cancelled', readComplete: false })
    expect(canSelect(cancelled)).toEqual({ canSelect: false, hint: 'read was cancelled — Run again to select' })
  })

  it('U-30: should allow selection on a cancelled run whose read completed', () => {
    const s = knownOf({ state: 'cancelled', readComplete: true, stage: 'epochs' })
    expect(canSelect(s)).toEqual({ canSelect: true })
  })

  it('U-30: should allow selection on a finished run', () => {
    expect(canSelect(knownOf({ state: 'done', readComplete: true }))).toEqual({ canSelect: true })
  })

  it('U-30: should not allow selection while a run is in flight', () => {
    expect(canSelect(knownOf({ state: 'computing', readComplete: true }))).toEqual({ canSelect: false })
    expect(canSelect(knownOf({ state: 'reading', readComplete: false }))).toEqual({ canSelect: false })
  })

  it('should not allow selection without a known run', () => {
    expect(canSelect(undefined)).toEqual({ canSelect: false })
    expect(canSelect({ jobId: 'j', state: 'unknown' })).toEqual({ canSelect: false })
  })
})

describe('canSelectLevel', () => {
  const level = (status: 'running' | 'done' | 'failed' | 'cancelled') => ({ runId: 'r1', status })

  it('U-30: should read readComplete from the live status of the level that owns it', () => {
    const cancelledRead = knownOf({ runId: 'r1', state: 'cancelled', readComplete: false })
    expect(canSelectLevel(cancelledRead, level('cancelled')).canSelect).toBe(false)
    expect(canSelectLevel(knownOf({ runId: 'r1', state: 'done', readComplete: true }), level('done'))).toEqual({ canSelect: true })
  })

  it('should allow selection from a finished level shown from its stored frames after Back', () => {
    const other = knownOf({ runId: 'r9', state: 'cancelled', readComplete: true })
    expect(canSelectLevel(other, level('done'))).toEqual({ canSelect: true })
  })

  it('should not allow selection from a stored level that did not finish', () => {
    const other = knownOf({ runId: 'r9', state: 'done', readComplete: true })
    for (const s of ['running', 'failed', 'cancelled'] as const) {
      expect(canSelectLevel(other, level(s)).canSelect).toBe(false)
    }
  })

  it('should not allow selection without a level', () => {
    expect(canSelectLevel(undefined, undefined)).toEqual({ canSelect: false })
  })
})
