import { describe, expect, it } from 'vitest'
import { colorScale } from './colors'
import { onColourChange, resolveRun, runAction, framesToDraw } from './breadcrumb'
import { FILTER, levelOf, threeLevels } from './breadcrumb.fixtures'
import { controlsFromScope } from './defaults'
import { knownOf, scopeOf } from './status.fixtures'

const scope = scopeOf({ method: 'umap', dims: 2, vector: 'v', limit: 5000 })
const view = { connectionId: 'c1', collection: 'A', tenant: 't1' }
const base = controlsFromScope(scope)

describe('runAction', () => {
  it('should run the root at the root level', () => {
    expect(runAction([levelOf()], 0, { ...base, filters: FILTER }, scope)).toEqual({ kind: 'root' })
    expect(runAction([], 0, base, scope)).toEqual({ kind: 'root' })
  })

  it('U-34: should re-run the level when only dims changed', () => {
    expect(runAction(threeLevels(), 2, { ...base, dims: 3 }, scope)).toEqual({ kind: 'rerunLevel', index: 2 })
  })

  it('U-34: should re-run the level when only the method changed', () => {
    expect(runAction(threeLevels(), 2, { ...base, method: 'pca' }, scope)).toEqual({ kind: 'rerunLevel', index: 2 })
  })

  it('U-34: should confirm before a root re-run from below the root', () => {
    expect(runAction(threeLevels(), 2, { ...base, filters: FILTER }, scope)).toEqual({ kind: 'confirmRoot', levels: 3 })
    expect(runAction(threeLevels(), 1, { ...base, limit: 10 }, scope)).toEqual({ kind: 'confirmRoot', levels: 3 })
    expect(runAction(threeLevels(), 2, { ...base, vector: 'w' }, scope)).toEqual({ kind: 'confirmRoot', levels: 3 })
  })
})

describe('resolveRun', () => {
  const ctx = { jobId: 'j1', levels: threeLevels(), controls: { ...base, dims: 3 as const }, view }
  const confirm = { kind: 'confirmRoot', levels: 3 } as const

  it('U-34: should clear to the root and send a read request once confirmed', () => {
    const r = resolveRun(confirm, true, { ...ctx, controls: { ...base, filters: FILTER } })
    expect(r.request).toMatchObject({
      source: { kind: 'read', connectionId: 'c1', collection: 'A', tenant: 't1', vector: 'v', limit: 5000, filters: FILTER },
      method: 'umap',
      dims: 2
    })
    expect(r.levels.map((l) => l.runId)).toEqual(['r1'])
  })

  it('U-34: should send nothing and keep the levels when the confirmation is declined', () => {
    for (const confirmed of [false, undefined]) {
      const r = resolveRun(confirm, confirmed, ctx)
      expect(r.request).toBeNull()
      expect(r.levels).toHaveLength(3)
    }
  })

  it("U-34: should re-run a level as a selection with that level's indices and the current dims", () => {
    const r = resolveRun({ kind: 'rerunLevel', index: 2 }, undefined, ctx)
    expect(r.request).toEqual({
      source: { kind: 'selection', jobId: 'j1', indices: [5, 9] },
      method: 'umap',
      dims: 3
    })
  })

  it('should send the root read request for a root run', () => {
    const r = resolveRun({ kind: 'root' }, undefined, { ...ctx, levels: [levelOf()], controls: base })
    expect(r.request?.source).toMatchObject({ kind: 'read', collection: 'A', limit: 5000 })
  })

  it('should send nothing when the level to re-run does not exist', () => {
    expect(resolveRun({ kind: 'rerunLevel', index: 7 }, undefined, ctx).request).toBeNull()
  })
})

describe('onColourChange', () => {
  it('U-35: should recolour at level 1 without a run', () => {
    expect(onColourChange({ level: 1 }, 'year')).toEqual({ start: null, colourProp: 'year' })
    expect(onColourChange({ level: 0 }, null)).toEqual({ start: null, colourProp: null })
    const root = colorScale('int', [1990, 2005, 2020])
    expect(root.legend.slice(0, 2).map((l) => l.label)).toEqual(['1990', '2020'])
  })
})

describe('framesToDraw', () => {
  const live = knownOf({ runId: 'r2', pca: 'LIVE-P', umap: { coords: 'LIVE-U', epoch: 5, epochs: 50, dims: 2 } })

  it('should draw the live status frames for the level that owns them', () => {
    expect(framesToDraw(live, levelOf({ runId: 'r2', dims: 2 }))).toEqual({
      pca: 'LIVE-P', umap: { coords: 'LIVE-U', dims: 2 }
    })
  })

  it('U-22: should draw the level stored frames when the status belongs to another run', () => {
    const level = levelOf({ runId: 'r1', dims: 3, pcaFrame: 'P', umapFrame: 'U' })
    expect(framesToDraw(live, level)).toEqual({ pca: 'P', umap: { coords: 'U', dims: 3 } })
  })

  it('should draw nothing for a level that stored no frame', () => {
    expect(framesToDraw(undefined, levelOf())).toEqual({})
  })
})
