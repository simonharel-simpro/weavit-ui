import { describe, expect, it } from 'vitest'
import type { FilterNode, NamedVectorConfig, PropertyConfig, PropValue } from '@shared/types'
import {
  canRun,
  controlsFromScope,
  defaultControls,
  defaultRoles,
  isEdited,
  resolveRole,
  roleColumn,
  scalarType,
  startRequest
} from './defaults'
import { scopeOf } from './status.fixtures'

const prop = (name: string, dataType: string): PropertyConfig => ({ name, dataType: [dataType] })
const vec = (name: string, multiVector?: boolean): NamedVectorConfig => ({ name, multiVector })

describe('projection defaults', () => {
  it('U-3: should default the label to the first text property, else uuid', () => {
    expect(defaultRoles([prop('n', 'int'), prop('title', 'text'), prop('body', 'text')]).labelProp).toBe('title')
    expect(defaultRoles([prop('n', 'int')]).labelProp).toBeUndefined()
  })

  it('U-3: should recolour from the prefetched column without a re-run', () => {
    const T: PropValue[] = ['a', 'b']
    const Y: PropValue[] = [1999, 2001]
    const points = { uuids: ['u1', 'u2'], props: ['title', 'year'], columns: [T, Y], runId: 'r1' }
    expect(roleColumn(points, 'year')).toBe(Y)
    expect(roleColumn(points, 'nope')).toBeUndefined()
    const scope = scopeOf({ vector: 'v', method: 'pca', dims: 3, limit: 5000 })
    expect(isEdited(controlsFromScope(scope), scope)).toBe(false)
  })

  it('defaults: array properties are never offered', () => {
    const tags = prop('tags', 'text[]')
    expect(scalarType(tags)).toBeUndefined()
    expect(scalarType(prop('title', 'text'))).toBe('text')
    expect(defaultRoles([tags, prop('title', 'text')])).toEqual({ labelProp: 'title' })
  })

  it('U-25: should assign Colour and Label roles from the schema', () => {
    expect(defaultRoles([prop('title', 'text'), prop('category', 'text')])).toEqual({
      labelProp: 'title',
      colourProp: 'category'
    })
    expect(defaultRoles([prop('title', 'text')])).toEqual({ labelProp: 'title' })
    expect(defaultRoles([prop('n', 'int')])).toEqual({})
  })

  it('U-47: should disable Run without a single-vector space', () => {
    const c = defaultControls({ namedVectors: [vec('colbert', true)] })
    expect(c.vector).toBeUndefined()
    expect(canRun(c)).toEqual({ ok: false, hint: 'no single-vector space (#32)' })
  })

  it('U-31: should default to UMAP, 2D and the first single-vector space', () => {
    const c = defaultControls({
      namedVectors: [vec('colbert', true), vec('title_vec'), vec('body_vec')]
    })
    expect(c).toEqual({ vector: 'title_vec', method: 'umap', dims: 2, limit: 100_000, filters: [] })
    expect(canRun(c)).toEqual({ ok: true })
  })

  it('U-24: should restore the controls from the run scope', () => {
    const F: FilterNode[] = [
      { property: 'year', operator: 'GreaterThan', value: '2000', valueType: 'int' }
    ]
    const scope = scopeOf({ vector: 'v', filters: F, method: 'pca', dims: 3, limit: 5000, props: ['a'] })
    const controls = controlsFromScope(scope)
    expect(controls).toEqual({ vector: 'v', filters: F, method: 'pca', dims: 3, limit: 5000 })
    expect(isEdited({ ...controls, limit: 4000 }, scope)).toBe(true)
  })
})

describe('resolveRole', () => {
  const props = ['title', 'year']
  it('should keep a chosen prop, fall back to the default, and honour an explicit clear', () => {
    expect(resolveRole('year', 'title', props)).toBe('year')
    expect(resolveRole(undefined, 'title', props)).toBe('title')
    expect(resolveRole(null, 'title', props)).toBeUndefined()
  })

  it('should ignore a prop that the run did not prefetch', () => {
    expect(resolveRole('gone', 'title', props)).toBe('title')
    expect(resolveRole(undefined, 'gone', props)).toBeUndefined()
  })
})

describe('startRequest', () => {
  const view = { connectionId: 'c1', collection: 'A', tenant: 't1' }
  it('should build a read request from the run inputs and leave colour/label out (D-21)', () => {
    const controls = { vector: 'v', limit: 5000, filters: [], method: 'pca' as const, dims: 3 as const }
    expect(startRequest(view, controls)).toEqual({
      source: { kind: 'read', connectionId: 'c1', collection: 'A', tenant: 't1', vector: 'v', filters: undefined, limit: 5000 },
      method: 'pca',
      dims: 3
    })
  })

  it('should refuse to build a request without a vector', () => {
    expect(() => startRequest(view, defaultControls({ namedVectors: [] }))).toThrow('needs a vector')
  })
})

describe('isEdited after a 2D → 3D → 2D round trip', () => {
  it('should clear the edited state when the controls match the run scope again', () => {
    const scope = scopeOf({ dims: 2 })
    const base = controlsFromScope(scope)
    expect(isEdited({ ...base, dims: 3 }, scope)).toBe(true)
    expect(isEdited({ ...base, dims: 2 }, scope)).toBe(false)
  })
})
