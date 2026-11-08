import type { ProjectionStatus } from '@shared/types'
import { shouldDraw } from './breadcrumb'
import { isKnown } from './frame'

export const READ_CANCELLED_HINT = 'read was cancelled — Run again to select'
const READ_INCOMPLETE_HINT = 'the read did not complete — Run again to select'

/**
 * Even-odd ray casting. `screenXY` holds n interleaved (x, y) pairs; the result is the
 * ascending view-relative indices of the points inside. A point exactly on an edge
 * counts as inside or outside by the half-open crossing rule, consistently.
 */
export function pointsInPolygon(screenXY: Float32Array, n: number, polygon: [number, number][]): number[] {
  const out: number[] = []
  if (polygon.length < 3) return out
  for (let i = 0; i < n; i++) {
    const x = screenXY[i * 2] as number
    const y = screenXY[i * 2 + 1] as number
    let inside = false
    for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
      const [ax, ay] = polygon[a] as [number, number]
      const [bx, by] = polygon[b] as [number, number]
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
    }
    if (inside) out.push(i)
  }
  return out
}

/** Maps view-relative indices to root-dataset indices; the root level (no `levelIndices`) is the identity. */
export function toRootIndices(viewIndices: number[], levelIndices?: number[]): number[] {
  if (!levelIndices) return viewIndices
  return viewIndices.map((i) => {
    const root = levelIndices[i]
    if (root === undefined) throw new RangeError(`index ${i} is outside the level (${levelIndices.length} points)`)
    return root
  })
}

/** Reads `readComplete`, never `stage` (U-30): a cancelled run that finished reading can still be selected from. */
export function canSelect(status: ProjectionStatus | undefined): { canSelect: boolean; hint?: string } {
  if (!isKnown(status)) return { canSelect: false }
  if (status.state === 'reading' || status.state === 'computing') return { canSelect: false }
  if (!status.readComplete) {
    return { canSelect: false, hint: status.state === 'cancelled' ? READ_CANCELLED_HINT : READ_INCOMPLETE_HINT }
  }
  return { canSelect: true }
}

/** The level on screen: the live status when it owns it, else the level's own outcome (after Back). */
export function canSelectLevel(
  status: ProjectionStatus | undefined,
  level: { runId: string; status: 'running' | 'done' | 'failed' | 'cancelled' } | undefined
): { canSelect: boolean; hint?: string } {
  if (!level) return { canSelect: false }
  if (shouldDraw(status, level)) return canSelect(status)
  return { canSelect: level.status === 'done' }
}
