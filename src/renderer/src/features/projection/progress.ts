import type { CapReason, ProjectionStage, ProjectionStatusKnown } from '@shared/types'

type Skipped = NonNullable<ProjectionStatusKnown['skipped']>
type Cap = NonNullable<ProjectionStatusKnown['cap']>

/** Never reports 100 % before the run is done (U-19). */
function percent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(99, Math.floor((done / total) * 100))
}

export function progressText(
  stage: ProjectionStage,
  done: number,
  total: number | undefined,
  locale?: string
): string {
  const nf = new Intl.NumberFormat(locale)
  const of = total === undefined ? nf.format(done) : `${nf.format(done)} / ${nf.format(total)}`
  switch (stage) {
    case 'reading':
      return `Reading ${of}`
    case 'pca':
      return `PCA ${of} rows`
    case 'knn':
      return total === undefined ? 'kNN' : `kNN ${nf.format(percent(done, total))} %`
    case 'graph':
      return 'Building graph'
    case 'epochs':
      return `UMAP epoch ${of}`
  }
}

export function cancelledBadge(
  status: Pick<ProjectionStatusKnown, 'stage' | 'progress'>,
  locale?: string
): string {
  if (!status.stage) return 'cancelled'
  const { done = 0, total } = status.progress ?? {}
  return `cancelled at ${progressText(status.stage, done, total, locale)}`
}

const CAP_BASIS: Record<CapReason, string> = {
  limit: 'UUID cursor',
  offsetLimit: 'server limit',
  dimension: 'dimension cap'
}

export function capBanner(cap: Cap, locale?: string): string {
  const nf = new Intl.NumberFormat(locale)
  const head = cap.matched === undefined ? '' : `${nf.format(cap.read)} / ${nf.format(cap.matched)} — `
  return `${head}first ${nf.format(cap.read)} in server order (${CAP_BASIS[cap.reason]})`
}

/** Every non-zero count, in the order missing, dim, nonFinite, zeroNorm (U-50). */
export function skippedBanner(skipped: Skipped, vector: string, locale?: string): string | null {
  const nf = new Intl.NumberFormat(locale)
  const parts: [number, string][] = [
    [skipped.missing, `without vector ${vector}`],
    [skipped.dim, 'wrong length'],
    [skipped.nonFinite, 'non-finite'],
    [skipped.zeroNorm, 'zero norm']
  ]
  const text = parts.filter(([n]) => n > 0).map(([n, label]) => `${nf.format(n)} ${label}`)
  return text.length > 0 ? text.join(', ') : null
}
