import { describe, expect, it } from 'vitest'
import type { FilterNode, PlaceQueryResult, SearchResult, WeaviateObject } from '@shared/types'
import {
  approximateBadge,
  highlightSet,
  hitUuidsOf,
  mergeHighlight,
  hitsForPlacement,
  overlaySearchRequest,
  parseVector,
  placementKey,
  uuidIndexOf
} from './overlay'
import { scopeOf } from './status.fixtures'

const F: FilterNode[] = [{ property: 'year', operator: 'GreaterThan', value: '2000', valueType: 'int' }]
const obj = (uuid: string, metadata: Record<string, unknown> = {}): WeaviateObject => ({
  uuid,
  properties: {},
  metadata
})
const result = (...objects: WeaviateObject[]): SearchResult => ({ objects })

describe('overlaySearchRequest', () => {
  it("U-5: should build the overlay search with the run's tenant, vector and filter", () => {
    const scope = scopeOf({ connectionId: 'c', collection: 'C', tenant: 't1', vector: 'title_vec', filters: F })
    expect(overlaySearchRequest(scope, { mode: 'nearText', text: 'pump' })).toEqual({
      connectionId: 'c',
      collection: 'C',
      type: 'nearText',
      tenant: 't1',
      targetVector: 'title_vec',
      filters: F,
      queryText: 'pump',
      limit: 20,
      includeVector: false
    })
  })

  it('overlay: vector and bm25 requests', () => {
    const scope = scopeOf({ vector: 'title_vec', filters: F })
    const vec = overlaySearchRequest(scope, { mode: 'vector', vector: [1, 2] })
    expect(vec.type).toBe('nearVector')
    expect(vec.queryVector).toBe('[1,2]')
    expect(vec.targetVector).toBe('title_vec')
    const bm25 = overlaySearchRequest(scope, { mode: 'bm25', text: 'pump' })
    expect(bm25.type).toBe('bm25')
    expect('targetVector' in bm25).toBe(false)
    const implicit = overlaySearchRequest(scopeOf({ vector: 'default' }), { mode: 'nearText', text: 'x' })
    expect('targetVector' in implicit).toBe(false)
    expect(overlaySearchRequest(scopeOf(), { mode: 'nearText', text: 'x' }).filters).toEqual([])
  })

  it('overlay: hybrid keeps the projected vector as its target', () => {
    const r = overlaySearchRequest(scopeOf({ vector: 'v' }), { mode: 'hybrid', text: 'pump' })
    expect(r).toMatchObject({ type: 'hybrid', queryText: 'pump', targetVector: 'v' })
  })

  it('overlay: k clamped', () => {
    const at = (k?: number): number => overlaySearchRequest(scopeOf(), { mode: 'nearText', text: 'x' }, k).limit
    expect(at(0)).toBe(1)
    expect(at(500)).toBe(100)
    expect(at(undefined)).toBe(20)
  })

  it('U-13: should request k + 1 for a nearObject search', () => {
    const r = overlaySearchRequest(scopeOf(), { mode: 'point', uuid: 'P' }, 20)
    expect(r).toMatchObject({ type: 'nearObject', queryObjectId: 'P', limit: 21 })
  })

  it('should reject an input that lacks the field its mode needs', () => {
    expect(() => overlaySearchRequest(scopeOf(), { mode: 'nearText', text: '  ' })).toThrow(/text/)
    expect(() => overlaySearchRequest(scopeOf(), { mode: 'vector' })).toThrow(/vector/)
    expect(() => overlaySearchRequest(scopeOf(), { mode: 'point' })).toThrow(/point/)
  })
})

describe('hitsForPlacement', () => {
  it('U-13: should drop the source object from nearObject hits and mark it exactly', () => {
    const res = result(obj('P'), obj('a'), obj('b'))
    expect(hitsForPlacement(res, 'point', 'P')).toEqual({ kind: 'object', uuid: 'P' })
    expect(hitUuidsOf(res, 'point', 'P')).toEqual(['a', 'b'])
  })

  it('U-10: metric per search mode', () => {
    const res = result(obj('a', { distance: 0.25, score: 0.9 }))
    expect(hitsForPlacement(res, 'nearText')).toEqual({
      kind: 'hits', metric: 'distance', hits: [{ uuid: 'a', distance: 0.25 }]
    })
    expect(hitsForPlacement(res, 'bm25')).toEqual({
      kind: 'hits', metric: 'score', hits: [{ uuid: 'a', score: 0.9 }]
    })
    expect(hitsForPlacement(res, 'hybrid')).toMatchObject({ kind: 'hits', metric: 'score' })
  })

  it('should keep a hit that lacks the ranked field, without inventing a number', () => {
    expect(hitsForPlacement(result(obj('a')), 'nearText')).toEqual({
      kind: 'hits', metric: 'distance', hits: [{ uuid: 'a' }]
    })
  })

  it('should place a vector query by its own vector', () => {
    expect(hitsForPlacement(result(obj('a')), 'vector', undefined, [1, 2])).toEqual({
      kind: 'vector', vector: [1, 2]
    })
    expect(hitUuidsOf(result(obj('a'), obj('b')), 'vector')).toEqual(['a', 'b'])
  })
})

describe('highlightSet', () => {
  it('U-12: highlight only hits present in the view', () => {
    const index = uuidIndexOf(Array.from({ length: 14 }, (_, i) => `u${i}`))
    const hits = Array.from({ length: 20 }, (_, i) => `u${i}`)
    const h = highlightSet(hits, index)
    expect(h.indices.size).toBe(14)
    expect(h.inView).toBe(14)
    expect(h.total).toBe(20)
  })

  it("U-33: should highlight a selection's local index only", () => {
    const root = Array.from({ length: 40 }, (_, i) => `u${i}`)
    const level = [10, 20, 30].map((i) => root[i] as string)
    const h = highlightSet(['u20', 'u5'], uuidIndexOf(level))
    expect([...h.indices]).toEqual([1])
    expect(h).toMatchObject({ inView: 1, total: 2 })
  })
})

describe('parseVector', () => {
  it('overlay: vector input validated', () => {
    expect(parseVector('[1, 2, x]', 384)).toEqual({ ok: false, error: 'not a number array' })
    const wrong = JSON.stringify(Array.from({ length: 128 }, () => 0.5))
    expect(parseVector(wrong, 384)).toEqual({ ok: false, error: 'dimension 128, expected 384' })
  })

  it('should parse a valid vector of the expected dimension', () => {
    expect(parseVector('[1, 2.5, -3]', 3)).toEqual({ ok: true, vector: [1, 2.5, -3] })
  })

  it('should refuse non-arrays and non-finite entries', () => {
    expect(parseVector('{"a":1}', 1)).toEqual({ ok: false, error: 'not a number array' })
    expect(parseVector('[1, null]', 2)).toEqual({ ok: false, error: 'not a number array' })
    expect(parseVector('[]', 0)).toEqual({ ok: false, error: 'not a number array' })
  })
})

describe('approximateBadge', () => {
  const r = (over: Partial<PlaceQueryResult>): PlaceQueryResult => ({ placed: true, approximate: true, ...over })

  it('U-21: should badge approximate placements', () => {
    expect(approximateBadge(r({ method: 'knn' }))).toBe('approximate (15-NN)')
    expect(approximateBadge(r({ method: 'centroid' }))).toBe('approximate (hit centroid)')
    expect(approximateBadge(r({ method: 'mean' }))).toBe('approximate (unweighted mean of hits)')
    expect(approximateBadge(r({ method: 'basis', approximate: false }))).toBeNull()
    expect(approximateBadge(r({ method: 'point', approximate: false }))).toBeNull()
  })
})

describe('placementKey', () => {
  it('U-23: should re-place the overlay on a new frame epoch, view or dims', () => {
    const base = placementKey({ runId: 'r1' }, 'umap', 2, 50)
    const later = placementKey({ runId: 'r1' }, 'umap', 2, 60)
    expect(later).not.toEqual(base)
    expect(later.slice(0, 3)).toEqual(['placeQuery', 'r1', 'umap'])
    expect(placementKey({ runId: 'r1' }, 'pca', 2, 50)).not.toEqual(base)
    expect(placementKey({ runId: 'r1' }, 'umap', 3, 50)).not.toEqual(base)
    expect(placementKey({ runId: 'r1' }, 'umap', 2, 50)).toEqual(base)
    expect(placementKey({ runId: 'r2' }, 'umap', 2, 50)).not.toEqual(base)
  })
})

describe('mergeHighlight', () => {
  it('should add the selected point to the hit highlight without mutating either', () => {
    const hits = new Set([1, 2])
    const merged = mergeHighlight(hits, 5)
    expect([...(merged ?? [])].sort()).toEqual([1, 2, 5])
    expect([...hits]).toEqual([1, 2])
  })

  it('should return the hits as they are when no point is selected, and nothing when both are absent', () => {
    const hits = new Set([1])
    expect(mergeHighlight(hits, undefined)).toBe(hits)
    expect(mergeHighlight(undefined, undefined)).toBeUndefined()
    expect([...(mergeHighlight(undefined, 3) ?? [])]).toEqual([3])
  })

  it('should ignore a negative selected index', () => {
    expect(mergeHighlight(undefined, -1)).toBeUndefined()
  })
})
