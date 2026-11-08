import { describe, expect, it, vi } from 'vitest'
import { CH } from '@shared/channels'
import type { ProjectionSession } from '../projection/session'
import { registerHandlers, type Handler } from './registry'

function wire(status: ProjectionSession['status'] = (jobId) => ({ jobId, state: 'unknown' })) {
  const projection: ProjectionSession = {
    start: vi.fn(async () => ({ jobId: 'j', runId: 'r' })),
    status: vi.fn(status),
    cancel: vi.fn(),
    placeQuery: vi.fn(() => ({ placed: false, approximate: false })),
    dispose: vi.fn()
  }
  const handlers = new Map<string, Handler>()
  registerHandlers((channel, fn) => handlers.set(channel, fn), { projection })
  const call = (channel: string, ...args: unknown[]) => (handlers.get(channel) as Handler)(...args)
  return { projection, call }
}

describe('projection channels', () => {
  it('should parse status args as each transport delivers them', () => {
    const { projection, call } = wire()
    call(CH.projection.status, 'j', undefined) // IPC keeps the trailing undefined
    call(CH.projection.status, 'j') // the web transport drops it
    call(CH.projection.status, 'j', { since: 3, points: true, runId: 'r' })
    expect(vi.mocked(projection.status).mock.calls).toEqual([
      ['j', undefined],
      ['j', undefined],
      ['j', { since: 3, points: true, runId: 'r' }]
    ])
  })

  it('F-12: status should answer unknown instead of throwing', () => {
    const { call } = wire(() => {
      throw new Error('boom')
    })
    expect(call(CH.projection.status, 'j')).toEqual({ jobId: 'j', state: 'unknown' })
    expect(call(CH.projection.status, 42)).toEqual({ jobId: '', state: 'unknown' })
    expect(call(CH.projection.status, 'j', { bogus: true })).toEqual({ jobId: 'j', state: 'unknown' })
  })

  it('should reject malformed cancel and placeQuery args before the session sees them', () => {
    const { projection, call } = wire()
    expect(() => call(CH.projection.cancel, 7)).toThrow()
    expect(() => call(CH.projection.placeQuery, { jobId: 'j' })).toThrow()
    expect(projection.cancel).not.toHaveBeenCalled()
    expect(projection.placeQuery).not.toHaveBeenCalled()
    call(CH.projection.cancel, 'j')
    expect(projection.cancel).toHaveBeenCalledWith('j')
  })
})
