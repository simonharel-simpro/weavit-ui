import { describe, expect, it } from 'vitest'
import type { CollectionConfig, NamedVectorConfig, ProjectionScope } from '@shared/types'
import {
  cancelArgsSchema,
  colourableProps,
  effectiveCap,
  metricOf,
  placeQuerySchema,
  scopeSchema,
  startRequestSchema,
  statusArgsSchema,
  validateStart
} from './validate'

function config(namedVectors: NamedVectorConfig[], props: [string, string][] = []): CollectionConfig {
  return {
    name: 'Docs',
    properties: props.map(([name, dt]) => ({ name, dataType: [dt] })),
    references: [],
    namedVectors,
    multiTenancy: { enabled: false },
    raw: {}
  }
}

const CONFIG = config(
  [{ name: 'body', distance: 'dot' }, { name: 'colbert', multiVector: true }],
  [['title', 'text']]
)
const read = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  source: { kind: 'read', connectionId: 'c', collection: 'Docs', vector: 'body', limit: 1000, ...over },
  method: 'umap',
  dims: 2,
  ...top
})
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const DATASET = { jobId: 'j1', n: 100, complete: true }
const selection = (indices: number[], jobId = 'j1') => ({
  source: { kind: 'selection', jobId, indices },
  method: 'pca',
  dims: 3
})

describe('validateStart', () => {
  it('accepts a read and derives metric, includeVector and props', () => {
    const v = validateStart(read(), { config: CONFIG })
    expect(v).toMatchObject({ kind: 'read', metric: 'dot', includeVector: ['body'], props: ['title'] })
  })

  it('accepts a selection of the complete dataset', () => {
    expect(validateStart(selection(range(16)), { dataset: DATASET })).toMatchObject({
      kind: 'selection',
      method: 'pca',
      dims: 3
    })
  })

  it.each([
    ['dims 4', read({}, { dims: 4 }), { config: CONFIG }],
    ['method "tsne"', read({}, { method: 'tsne' }), { config: CONFIG }],
    ['limit 0', read({ limit: 0 }), { config: CONFIG }],
    ['limit 100 001', read({ limit: 100_001 }), { config: CONFIG }],
    ['an unknown vector', read({ vector: 'nope' }), { config: CONFIG }],
    ['a multi-vector space', read({ vector: 'colbert' }), { config: CONFIG }],
    ['indices [-1]', selection([-1, ...range(16)]), { dataset: DATASET }],
    ['indices [1.5]', selection([1.5, ...range(16)]), { dataset: DATASET }],
    ['duplicate indices', selection([0, ...range(16)]), { dataset: DATASET }],
    ['10 indices', selection(range(10)), { dataset: DATASET }],
    ['a stale jobId', selection(range(16), 'old'), { dataset: DATASET }],
    ['an incomplete dataset', selection(range(16)), { dataset: { ...DATASET, complete: false } }]
  ])('F-14: should reject %s before spawning', (_label, req, ctx) => {
    expect(() => validateStart(req, ctx)).toThrow(Error)
  })

  it('names the multi-vector reason', () => {
    expect(() => validateStart(read({ vector: 'colbert' }), { config: CONFIG })).toThrow(
      'multi-vector spaces are not supported'
    )
  })

  it('rejects an index outside [0, n)', () => {
    expect(() => validateStart(selection([...range(15), 100]), { dataset: DATASET })).toThrow()
  })
})

describe('metricOf and colourableProps', () => {
  it('U-37: keeps the server metric verbatim and defaults to cosine', () => {
    expect(metricOf({ name: 'v', distance: 'manhattan' })).toBe('manhattan')
    expect(metricOf({ name: 'v', distance: 'foo' })).toBe('foo')
    expect(metricOf({ name: 'v' })).toBe('cosine')
  })

  it('D-21: should prefetch every colourable scalar property', () => {
    const c = config([], [
      ['title', 'text'],
      ['year', 'int'],
      ['price', 'number'],
      ['ok', 'boolean'],
      ['tags', 'text[]'],
      ['when', 'date']
    ])
    expect(colourableProps(c)).toEqual(['title', 'year', 'price', 'ok'])
  })
})

describe('schemas', () => {
  it('U-42: startRequestSchema satisfies the request type', () => {
    // The compile-time half is the `satisfies` clause in validate.ts (tsc).
    expect(startRequestSchema.safeParse(read({ filters: [{}] })).success).toBe(true)
    expect(startRequestSchema.safeParse(read({ filters: [3] })).success).toBe(false)
    expect(startRequestSchema.safeParse(read({ filters: [null] })).success).toBe(false)
  })

  it('scope: a ProjectionScope sample round-trips through scopeSchema', () => {
    const sample: Required<ProjectionScope> = {
      connectionId: 'c',
      collection: 'Docs',
      tenant: 't1',
      vector: 'body',
      filters: [{ kind: 'group', operator: 'And', children: [] }],
      method: 'umap',
      dims: 3,
      limit: 5000,
      props: ['title', 'year'],
      dim: 384,
      metric: 'cosine',
      selection: 42
    }
    expect(scopeSchema.parse(sample)).toEqual(sample)
    expect(Object.keys(sample).sort()).toEqual([...scopeSchema.keyof().options].sort())
  })

  it('channel args: status, cancel and placeQuery are parsed', () => {
    expect(statusArgsSchema.safeParse(['']).success).toBe(false)
    expect(statusArgsSchema.safeParse(['j', { since: 1.5 }]).success).toBe(false)
    expect(statusArgsSchema.safeParse(['j']).success).toBe(true)
    expect(statusArgsSchema.parse(['j', { points: true, runId: 'r1' }])).toEqual([
      'j',
      { points: true, runId: 'r1' }
    ])
    expect(cancelArgsSchema.safeParse([42]).success).toBe(false)
    const place = { jobId: 'j', runId: 'r', view: 'pca', query: { kind: 'object', uuid: 'u' } }
    expect(placeQuerySchema.safeParse(place).success).toBe(true)
    expect(placeQuerySchema.safeParse({ ...place, view: 'tsne' }).success).toBe(false)
    expect(placeQuerySchema.safeParse({ ...place, extra: 1 }).success).toBe(false)
  })
})

describe('effectiveCap', () => {
  it('U-8: should compute the effective cap from n and n·d', () => {
    expect(effectiveCap({ limit: 100_000, d: 384, matched: 250_000 })).toEqual({ cap: 100_000, reason: 'limit' })
    expect(effectiveCap({ limit: 100_000, d: 1536 })).toEqual({ cap: 66_666, reason: 'dimension' })
    expect(effectiveCap({ limit: 100_000, d: 384, matched: 100_000 })).toEqual({ cap: 100_000 })
    expect(effectiveCap({ limit: 5000, d: 384, matched: 20_000 })).toEqual({ cap: 5000, reason: 'limit' })
  })

  it('U-1: caps a filtered read at the offset limit', () => {
    expect(effectiveCap({ limit: 100_000, d: 384, matched: 25_000, filtered: true })).toEqual({
      cap: 10_000,
      reason: 'offsetLimit'
    })
    expect(effectiveCap({ limit: 100_000, d: 384, matched: 8000, filtered: true })).toEqual({ cap: 10_000 })
  })
})
