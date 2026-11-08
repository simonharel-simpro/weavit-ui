import { describe, expect, it } from 'vitest'
import { PointCloudLayer, ScatterplotLayer } from '@deck.gl/layers'
import { buildLayers } from './layers'

interface BinaryData {
  length: number
  attributes: Record<string, { value: Float32Array | Uint8Array; size: number }>
}
const dataOf = (layer: unknown): BinaryData => (layer as { props: { data: BinaryData } }).props.data

const coords2 = new Float32Array([0, 0, 1, 1, 2, 2])
const colors = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
const coords3 = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2])

describe('buildLayers', () => {
  it('should build a ScatterplotLayer with a 3-byte fill colour attribute for a 2D frame', () => {
    const [points] = buildLayers({ coords: coords2, dims: 2, n: 3, colors }, undefined, undefined)
    expect(points).toBeInstanceOf(ScatterplotLayer)
    expect(points?.id).toBe('points-2d')
    const data = dataOf(points)
    expect(data.length).toBe(3)
    expect(data.attributes.getPosition?.size).toBe(2)
    expect(data.attributes.getFillColor?.value).toBeInstanceOf(Uint8Array)
    expect(data.attributes.getFillColor?.size).toBe(3)
    expect(data.attributes.getColor).toBeUndefined()
  })

  it('should build a PointCloudLayer with a 3-byte colour attribute for the 3D view', () => {
    const [points] = buildLayers({ coords: coords3, dims: 3, n: 3, colors }, undefined, undefined)
    expect(points).toBeInstanceOf(PointCloudLayer)
    expect(points?.id).toBe('points-3d')
    const data = dataOf(points)
    expect(data.attributes.getPosition?.size).toBe(3)
    expect(data.attributes.getColor?.value).toBeInstanceOf(Uint8Array)
    expect(data.attributes.getColor?.size).toBe(3)
  })

  it('should add a white highlight layer for in-range indices only', () => {
    const layers = buildLayers({ coords: coords2, dims: 2, n: 3, colors }, new Set([1, 7, -1]), undefined)
    expect(layers.map((l) => l.id)).toEqual(['points-2d', 'highlight-2d'])
    const data = dataOf(layers[1])
    expect(data.length).toBe(1)
    expect(Array.from(data.attributes.getPosition?.value ?? [])).toEqual([1, 1])
    expect(Array.from(data.attributes.getFillColor?.value ?? [])).toEqual([255, 255, 255])
  })

  it('should add a pink marker layer at the given position', () => {
    const layers = buildLayers({ coords: coords3, dims: 3, n: 3, colors }, undefined, [4, 5, 6])
    expect(layers.map((l) => l.id)).toEqual(['points-3d', 'marker-3d'])
    const data = dataOf(layers[1])
    expect(Array.from(data.attributes.getPosition?.value ?? [])).toEqual([4, 5, 6])
    expect(Array.from(data.attributes.getColor?.value ?? [])).toEqual([255, 64, 129])
  })
})
