import { describe, expect, it } from 'vitest'
import { cancelledBadge, capBanner, progressText, skippedBanner } from './progress'
import { knownOf } from './status.fixtures'

describe('progress text', () => {
  it('U-52: should format every stage', () => {
    expect(progressText('pca', 10_000, 37_512, 'en')).toBe('PCA 10,000 / 37,512 rows')
    expect(progressText('graph', 0, undefined, 'en')).toBe('Building graph')
  })

  it('U-19: should format progress per stage and never show 100% before done', () => {
    expect(progressText('knn', 99_999, 100_000, 'en')).toBe('kNN 99 %')
    expect(progressText('knn', 100_000, 100_000, 'en')).toBe('kNN 99 %')
    expect(progressText('reading', 37_512, 100_000, 'en')).toBe('Reading 37,512 / 100,000')
    expect(progressText('epochs', 90, 200, 'en')).toBe('UMAP epoch 90 / 200')
  })

  it('F-1: should format reading progress without a total', () => {
    expect(progressText('reading', 37_512, undefined, 'en')).toBe('Reading 37,512')
  })

  it('U-15: should show the cancelled badge with the kept stage', () => {
    const status = knownOf({ state: 'cancelled', stage: 'epochs', progress: { done: 90, total: 200 } })
    expect(cancelledBadge(status, 'en')).toBe('cancelled at UMAP epoch 90 / 200')
  })

  it('U-29: should state the order basis in the cap banner', () => {
    expect(capBanner({ read: 100_000, matched: 250_000, reason: 'limit' }, 'en')).toBe(
      '100,000 / 250,000 — first 100,000 in server order (UUID cursor)'
    )
    expect(capBanner({ read: 10_000, matched: 25_000, reason: 'offsetLimit' }, 'en')).toBe(
      '10,000 / 25,000 — first 10,000 in server order (server limit)'
    )
    expect(capBanner({ read: 100_000, reason: 'limit' }, 'en')).toBe(
      'first 100,000 in server order (UUID cursor)'
    )
    expect(capBanner({ read: 66_666, matched: 100_000, reason: 'dimension' }, 'en')).toBe(
      '66,666 / 100,000 — first 66,666 in server order (dimension cap)'
    )
    expect(capBanner({ read: 66_666, reason: 'dimension' }, 'en')).toBe(
      'first 66,666 in server order (dimension cap)'
    )
  })

  it('U-50: should list every non-zero skipped count', () => {
    expect(skippedBanner({ missing: 0, dim: 3, nonFinite: 0, zeroNorm: 2 }, 'name', 'en')).toBe(
      '3 wrong length, 2 zero norm'
    )
    expect(skippedBanner({ missing: 3000, dim: 0, nonFinite: 4, zeroNorm: 0 }, 'name', 'en')).toBe(
      '3,000 without vector name, 4 non-finite'
    )
    expect(skippedBanner({ missing: 0, dim: 0, nonFinite: 0, zeroNorm: 0 }, 'name', 'en')).toBeNull()
  })
})
