import { describe, expect, it } from 'vitest'
import { decodeF32 } from '@shared/projection'
import type { ProjectionScope } from '@shared/types'
import { encodeF32, type SidecarMessage } from './protocol'
import { applyMessage, applyOutcome, applyPage, cancelRun, createRun, endRead, toStatus } from './run'

const scope: ProjectionScope = {
  connectionId: 'c',
  collection: 'A',
  vector: 'v',
  method: 'umap',
  dims: 2,
  limit: 5000,
  props: [],
  dim: 4,
  metric: 'cosine'
}
const read = () => createRun({ runId: 'r', jobId: 'j', kind: 'read', method: 'umap', dims: 2, scope })
const f32 = (n: number, v = 1): string => encodeF32(new Float32Array(n).fill(v))
const frame = (epoch: number, n = 2): SidecarMessage => ({
  type: 'frame',
  stage: 'umap',
  epoch,
  epochs: 200,
  dims: 2,
  n,
  coords: f32(n * 2)
})
const chunk = (offset: number, count: number): SidecarMessage => ({ type: 'pcaChunk', offset, count, coords: f32(count * 3) })
const status = (run: ReturnType<typeof read>, since?: number) => toStatus(run, undefined, { since }, new Map())

describe('run transitions', () => {
  it('run: transitions follow the table', () => {
    const run = read()
    expect(status(run)).toMatchObject({ state: 'reading', stage: 'reading', progress: { done: 0 }, n: 0, readComplete: false })
    applyPage(run, 1000)
    applyPage(run, 1000)
    expect(status(run)).toMatchObject({ n: 2000, progress: { done: 2000 } })
    applyMessage(run, { type: 'progress', stage: 'pca', done: 1000, total: 2000 })
    expect(status(run).stage).toBe('reading')
    endRead(run)
    expect(status(run)).toMatchObject({ state: 'computing', stage: 'pca', readComplete: true })
    applyMessage(run, frame(10))
    expect(status(run)).toMatchObject({ stage: 'epochs', progress: { done: 10, total: 200 } })
    applyOutcome(run, { ok: true, n: 2000 })
    expect(status(run)).toMatchObject({ state: 'done', n: 2000, progress: { done: 200, total: 200 } })
  })

  it('should start a selection with its rows already read', () => {
    const run = createRun({ runId: 's', jobId: 'j', kind: 'selection', indices: Uint32Array.from([1, 2, 3]), method: 'pca', dims: 2, scope })
    expect(status(run)).toMatchObject({ state: 'reading', readComplete: true, progress: { done: 0, total: 3 } })
  })

  it('should fail on a bad close and ignore a close after a terminal state', () => {
    const run = read()
    endRead(run)
    applyOutcome(run, { ok: false, error: 'exited with code 1' })
    expect(status(run)).toMatchObject({ state: 'failed', error: 'exited with code 1' })
    applyOutcome(run, { ok: true, n: 3 })
    expect(status(run).state).toBe('failed')
  })

  it('should keep readComplete false and the stage when cancelled mid-read', () => {
    const run = read()
    applyPage(run, 1000)
    cancelRun(run)
    endRead(run)
    applyOutcome(run, { ok: false, error: 'killed by SIGTERM' })
    expect(status(run)).toMatchObject({ state: 'cancelled', stage: 'reading', readComplete: false, n: 1000 })
  })

  it('should append sidecar notices to the seeded one', () => {
    const run = createRun({ runId: 'r', jobId: 'j', kind: 'read', method: 'umap', dims: 2, scope, notice: 'dot metric: Euclidean layout' })
    applyMessage(run, { type: 'notice', message: 'UMAP needs at least 16 points; PCA only' })
    expect(status(run).notice).toBe('dot metric: Euclidean layout; UMAP needs at least 16 points; PCA only')
  })
})

describe('toStatus payload', () => {
  it('status: coords only when frameVersion > since', () => {
    const run = read()
    applyMessage(run, chunk(0, 2))
    applyMessage(run, frame(10))
    applyMessage(run, frame(20))
    expect(status(run).frameVersion).toBe(3)
    const at3 = status(run, 3)
    expect(at3.pca).toBeUndefined()
    expect(at3.umap).toBeUndefined()
    expect(status(run, 2)).toMatchObject({ pca: expect.any(String), umap: { epoch: 20, epochs: 200, dims: 2 } })
    expect(status(run)).toMatchObject({ pca: expect.any(String), umap: expect.any(Object) })
  })

  it('U-45: should send only the PCA rows covered so far', () => {
    const run = read()
    for (let i = 0; i < 9; i++) applyPage(run, 1000)
    expect('pca' in status(run)).toBe(false)
    applyMessage(run, chunk(0, 10_000))
    expect(decodeF32(status(run).pca!).length).toBe(30_000)
    applyMessage(run, chunk(10_000, 1000))
    expect(decodeF32(status(run).pca!).length).toBe(33_000)
  })
})
