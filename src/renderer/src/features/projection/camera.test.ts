import { describe, expect, it } from 'vitest'
import { fitView } from './camera'

describe('fitView', () => {
  it('should centre a 2D cloud and zoom so its extent fills 90% of the smaller side', () => {
    const v = fitView(new Float32Array([0, 0, 10, 20]), 2, 2, 200, 100)
    expect(v.target).toEqual([5, 10, 0])
    expect(v.zoom).toBeCloseTo(Math.log2((0.9 * 100) / 20), 6)
  })

  it('should use the diagonal as the 3D extent', () => {
    const v = fitView(new Float32Array([0, 0, 0, 3, 4, 12]), 2, 3, 100, 100)
    expect(v.target).toEqual([1.5, 2, 6])
    expect(v.zoom).toBeCloseTo(Math.log2((0.9 * 100) / 13), 6)
  })

  it('should ignore non-finite points and survive a single point or no point', () => {
    expect(fitView(new Float32Array([NaN, 1, 4, 6]), 2, 2, 100, 100).target).toEqual([4, 6, 0])
    expect(fitView(new Float32Array([4, 6]), 1, 2, 100, 100).zoom).toBe(0)
    expect(fitView(new Float32Array([NaN, NaN]), 1, 2, 100, 100)).toEqual({ target: [0, 0, 0], zoom: 0 })
  })
})
