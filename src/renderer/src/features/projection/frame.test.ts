import { describe, expect, it } from 'vitest'
import type { ProjectionStatus } from '@shared/types'
import {
  acceptPoints,
  chooseFrame,
  afterDelete,
  drawable,
  isStale,
  markerFor,
  matchesView,
  mergeStatus,
  pcaCount,
  pcaView,
  pointsEnabled,
  pollInterval,
  sinceFor
} from './frame'
import { knownOf, scopeOf } from './status.fixtures'

describe('frame helpers', () => {
  it('U-4: should slice the 3-component PCA frame to 2D without a new run', () => {
    const pca = new Float32Array([1, 2, 3, 4, 5, 6])
    expect(Array.from(pcaView(pca, 2))).toEqual([1, 2, 4, 5])
    expect(Array.from(pcaView(pca, 3))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('U-53: should slice the 3-coordinate PCA marker for 2D', () => {
    expect(markerFor([1, 2, 3], 'pca', 2)).toEqual([1, 2])
    expect(markerFor([1, 2, 3], 'pca', 3)).toEqual([1, 2, 3])
    expect(pcaCount(new Float32Array(9))).toBe(3)
  })

  it('U-44: should restart since at -1 on a new run', () => {
    expect(sinceFor('r1', 'r1', 7)).toBe(7)
    expect(sinceFor('r1', 'r2', 7)).toBe(-1)
    expect(sinceFor(undefined, 'r1', 0)).toBe(-1)
  })

  it('U-39: should drop points from another run', () => {
    const points = { uuids: ['a'], props: [], columns: [], runId: 'L2' }
    expect(acceptPoints(knownOf({ points }), 'L1')).toBeUndefined()
    expect(acceptPoints(knownOf({ points: { ...points, runId: 'L1' } }), 'L1')).toEqual({
      ...points,
      runId: 'L1'
    })
  })

  it('U-51: should fetch points on any terminal state', () => {
    expect(pointsEnabled(knownOf({ state: 'cancelled', readComplete: false }))).toBe(true)
    expect(pointsEnabled(knownOf({ state: 'failed', readComplete: true }))).toBe(true)
    expect(pointsEnabled(knownOf({ state: 'reading', readComplete: false }))).toBe(false)
    expect(pointsEnabled(knownOf({ state: 'computing', readComplete: true }))).toBe(true)
  })

  it('U-51: should not request points after a failed read', () => {
    expect(pointsEnabled(knownOf({ state: 'failed', readComplete: false }))).toBe(false)
    expect(pointsEnabled(undefined)).toBe(false)
    expect(pointsEnabled({ jobId: 'j', state: 'unknown' })).toBe(false)
  })

  it('U-45: should count PCA points from the payload length', () => {
    expect(pcaCount(new Float32Array(6000))).toBe(2000)
  })

  it('U-4: should mark a finished UMAP view stale when dims change', () => {
    expect(isStale(2, 3, 'umap')).toBe(true)
    expect(isStale(2, 3, 'pca')).toBe(false)
  })

  it('U-6: should not render a frame whose collection/tenant differs from the open view', () => {
    const scope = scopeOf({ collection: 'A', tenant: 't1' })
    expect(matchesView(scope, { connectionId: 'c1', collection: 'B', tenant: 't1' })).toBe(false)
    expect(matchesView(scope, { connectionId: 'c1', collection: 'A', tenant: 't2' })).toBe(false)
    expect(matchesView(scope, { connectionId: 'c1', collection: 'A', tenant: 't1' })).toBe(true)
  })

  it('F-11: drawable counts finite points only', () => {
    expect(drawable(new Float32Array([0, 0, NaN, 1, 2, 2]), 2)).toBe(2)
  })

  it('F-12: should stop polling when status errors', () => {
    const data = (state: ProjectionStatus['state']): ProjectionStatus =>
      state === 'unknown' ? { jobId: 'j', state } : knownOf({ state })
    expect(pollInterval({ state: { data: undefined, error: new Error('x') } })).toBe(false)
    expect(pollInterval({ state: { data: data('failed'), error: null } })).toBe(false)
    expect(pollInterval({ state: { data: data('unknown'), error: null } })).toBe(false)
    expect(pollInterval({ state: { data: data('computing'), error: null } })).toBe(500)
  })

  it('frame: mergeStatus keeps coords when the next status omits them', () => {
    const P = 'UEFS'
    const prev = knownOf({ runId: 'r1', pca: P })
    expect(mergeStatus(prev, knownOf({ runId: 'r1' }))).toMatchObject({ runId: 'r1', pca: P })
    expect(mergeStatus(prev, knownOf({ runId: 'r2' }))).not.toMatchObject({ pca: expect.anything() })
  })

  it('U-18: should keep the frame unchanged after a delete from the drawer', () => {
    const C = new Float32Array([1, 2, 3])
    const out = afterDelete({ coords: C, n: 3, deleted: new Set() }, 'u')
    expect(out.coords).toBe(C)
    expect(out.n).toBe(3)
    expect(out.deleted.has('u')).toBe(true)
  })
})

describe('chooseFrame', () => {
  const pca = new Float32Array([1, 2, 3, 4, 5, 6])

  it('U-4: should show the PCA frame sliced to the wanted dims in the PCA view', () => {
    const f = chooseFrame({ pca }, 'pca', 2)
    expect(f).toMatchObject({ kind: 'pca', n: 2, dims: 2 })
    expect(Array.from(f?.coords ?? [])).toEqual([1, 2, 4, 5])
  })

  it('should fall back to PCA while the UMAP view has no frame yet', () => {
    expect(chooseFrame({ pca }, 'umap', 3)).toMatchObject({ kind: 'pca', n: 2, dims: 3 })
  })

  it('should show the UMAP frame at its own dims in the UMAP view', () => {
    const umap = { coords: new Float32Array([1, 2, 3, 4, 5, 6]), dims: 3 as const }
    expect(chooseFrame({ pca, umap }, 'umap', 2)).toMatchObject({ kind: 'umap', n: 2, dims: 3 })
    expect(chooseFrame({ pca, umap }, 'pca', 2)).toMatchObject({ kind: 'pca' })
  })

  it('should return nothing before any frame arrives', () => {
    expect(chooseFrame({}, 'pca', 2)).toBeUndefined()
  })
})
