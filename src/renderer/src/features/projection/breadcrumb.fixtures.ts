// Test builders for breadcrumb levels (only *.test.ts import it).
import type { FilterNode } from '@shared/types'
import type { BreadcrumbLevel } from '../../store'

export const FILTER: FilterNode[] = [{ property: 'year', operator: 'Equal', value: '1999', valueType: 'int' }]

export function levelOf(over: Partial<BreadcrumbLevel> = {}): BreadcrumbLevel {
  return { jobId: 'j1', runId: 'r1', label: 'All', dims: 2, status: 'done', ...over }
}

/** [All r1, Selection 1 r2, Selection 2 r3], all done. */
export function threeLevels(): BreadcrumbLevel[] {
  return [
    levelOf(),
    levelOf({ runId: 'r2', label: 'Selection 1 (4)', indices: [3, 5, 8, 9] }),
    levelOf({ runId: 'r3', label: 'Selection 2 (2)', indices: [5, 9] })
  ]
}
