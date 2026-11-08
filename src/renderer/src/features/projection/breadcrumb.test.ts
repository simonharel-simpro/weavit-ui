import { describe, expect, it } from 'vitest'
import type { ProjectionStartRequest } from '@shared/types'
import { back, outcomeOf, pushLevel, rerunLevel, selectionRequest, settleLevel, shouldDraw } from './breadcrumb'
import { levelOf, threeLevels } from './breadcrumb.fixtures'
import { knownOf } from './status.fixtures'

describe('pushLevel / settleLevel', () => {
  it('U-27: should push a level when its run starts and mark it when it fails', () => {
    const sel1 = levelOf({ runId: 'r2', label: 'Selection 1 (4)', status: 'running', indices: [1, 2, 3, 4] })
    const pushed = pushLevel([levelOf()], sel1)
    expect(pushed.map((l) => [l.runId, l.status])).toEqual([['r1', 'done'], ['r2', 'running']])
    const failed = settleLevel(pushed, 'r2', 'failed')
    expect(failed).toHaveLength(2)
    expect(failed[1]).toMatchObject({ runId: 'r2', status: 'failed', indices: [1, 2, 3, 4] })
  })

  it('U-22: should keep both frames per level for Back', () => {
    const running = pushLevel([levelOf()], levelOf({ runId: 'r2', status: 'running' }))
    const done = settleLevel(running, 'r2', 'done', { pcaFrame: 'P', umapFrame: 'U' })
    expect(done[1]).toMatchObject({ status: 'done', pcaFrame: 'P', umapFrame: 'U' })
    expect(done[0]).toEqual(levelOf())
  })

  it('should leave levels untouched when the settled run is not in the breadcrumb', () => {
    expect(settleLevel(threeLevels(), 'zzz', 'failed')).toEqual(threeLevels())
  })
})

describe('back', () => {
  it('U-27: should cancel and pop an in-flight child on Back', () => {
    const running = [levelOf(), levelOf({ jobId: 'jX', runId: 'r2', status: 'running' })]
    const r = back(running)
    expect(r.levels).toEqual([levelOf()])
    expect(r.cancelJobId).toBe('jX')
  })

  it('U-27: should pop a finished child without a cancel', () => {
    const r = back([levelOf(), levelOf({ runId: 'r2', status: 'done' })])
    expect(r.levels).toEqual([levelOf()])
    expect(r.cancelJobId).toBeUndefined()
  })

  it('should never pop the root level', () => {
    expect(back([levelOf()])).toEqual({ levels: [levelOf()] })
  })
})

describe('rerunLevel', () => {
  it('U-27: should replace a level on re-run with the same indices', () => {
    const levels = [levelOf(), levelOf({ runId: 'r2', label: 'Selection 1', indices: [3, 5, 7] })]
    const next = rerunLevel(levels, 1, 'r3', 3)
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ runId: 'r3', indices: [3, 5, 7], status: 'running', dims: 3 })
  })

  it('should drop the stale frames of the replaced level', () => {
    const levels = [levelOf(), levelOf({ runId: 'r2', pcaFrame: 'P', umapFrame: 'U' })]
    const next = rerunLevel(levels, 1, 'r3')
    expect(next[1]?.pcaFrame).toBeUndefined()
    expect(next[1]?.umapFrame).toBeUndefined()
  })
})

describe('selectionRequest', () => {
  it('U-27: a selection run uses the current dims control', () => {
    expect(selectionRequest('j', [1, 2, 3], 3).dims).toBe(3)
  })

  it('should send a selection source on the same job with root-relative indices', () => {
    const req: ProjectionStartRequest = selectionRequest('j', [4, 5], 2)
    expect(req).toEqual({ source: { kind: 'selection', jobId: 'j', indices: [4, 5] }, method: 'umap', dims: 2 })
  })

  it('should carry the method when a level is re-run with another method', () => {
    expect(selectionRequest('j', [4, 5], 2, 'pca').method).toBe('pca')
  })
})

describe('shouldDraw', () => {
  it('U-22: should not draw a status from another level', () => {
    expect(shouldDraw(knownOf({ runId: 'L2' }), { runId: 'L1' })).toBe(false)
    expect(shouldDraw(knownOf({ runId: 'L1' }), { runId: 'L1' })).toBe(true)
  })

  it('should not draw without a known status or a level', () => {
    expect(shouldDraw(undefined, { runId: 'L1' })).toBe(false)
    expect(shouldDraw({ jobId: 'j', state: 'unknown' }, { runId: 'L1' })).toBe(false)
    expect(shouldDraw(knownOf({ runId: 'L1' }), undefined)).toBe(false)
  })
})

describe('outcomeOf', () => {
  it('should map a terminal run state to the level outcome', () => {
    expect(outcomeOf('done')).toBe('done')
    expect(outcomeOf('failed')).toBe('failed')
    expect(outcomeOf('empty')).toBe('failed')
    expect(outcomeOf('cancelled')).toBe('cancelled')
    expect(outcomeOf('superseded')).toBe('cancelled')
  })

  it('should map a run that is still going to no outcome', () => {
    expect(outcomeOf('reading')).toBeUndefined()
    expect(outcomeOf('computing')).toBeUndefined()
    expect(outcomeOf('unknown')).toBeUndefined()
  })
})
