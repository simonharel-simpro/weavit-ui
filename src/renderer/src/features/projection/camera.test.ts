import { describe, expect, it } from 'vitest'
import { cameraKey, fitView, viewStateMatches } from './camera'

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

describe('cameraKey', () => {
  const base = { runId: 'r1', frame: { kind: 'umap' as const, dims: 2 as const }, settled: false }

  it('should refit when the UMAP view switches to the PCA frame of the same run and dims', () => {
    const pca = { ...base, frame: { kind: 'pca' as const, dims: 2 as const } }
    expect(cameraKey(pca)).not.toBe(cameraKey(base))
  })

  it('should refit when going back to the UMAP frame after 3D then 2D (empty-canvas regression)', () => {
    const pca3 = { ...base, frame: { kind: 'pca' as const, dims: 3 as const } }
    const pca2 = { ...base, frame: { kind: 'pca' as const, dims: 2 as const } }
    expect(cameraKey(base)).not.toBe(cameraKey(pca2))
    expect(cameraKey(pca2)).not.toBe(cameraKey(pca3))
  })

  it('should keep the camera across intermediate frames of the same run, view and dims', () => {
    expect(cameraKey({ ...base })).toBe(cameraKey({ ...base }))
  })

  it('should refit once when the run settles, and again for a new run', () => {
    expect(cameraKey({ ...base, settled: true })).not.toBe(cameraKey(base))
    expect(cameraKey({ ...base, runId: 'r2' })).not.toBe(cameraKey(base))
  })
})

describe('viewStateMatches', () => {
  it('should reject an orbit state for a 2D view and an orthographic state for a 3D view', () => {
    const orbit = { target: [0, 0, 0], zoom: 1, rotationX: 30, rotationOrbit: 30 }
    const ortho = { target: [0, 0, 0], zoom: 1 }
    expect(viewStateMatches(2, orbit)).toBe(false)
    expect(viewStateMatches(2, ortho)).toBe(true)
    expect(viewStateMatches(3, orbit)).toBe(true)
    expect(viewStateMatches(3, ortho)).toBe(false)
  })
})
