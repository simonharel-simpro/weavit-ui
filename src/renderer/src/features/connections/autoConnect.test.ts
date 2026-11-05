import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { __resetForTests, autoConnectOnce, decideAutoConnect } from './autoConnect'

function profile(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'dl-1',
    name: 'data-lab',
    type: 'local',
    authType: 'none',
    localHost: '127.0.0.1',
    localPort: 8090,
    localGrpcPort: 50052,
    ...overrides
  }
}

const localOther: ConnectionConfig = {
  id: 'demo-rag',
  name: 'demo-rag',
  type: 'local',
  authType: 'none',
  localHost: 'localhost',
  localPort: 8080,
  localGrpcPort: 50051
}

const cloud: ConnectionConfig = {
  id: 'wcs',
  name: 'prod-cloud',
  type: 'cloud',
  authType: 'apiKey',
  clusterUrl: 'https://x.weaviate.cloud'
}

describe('decideAutoConnect', () => {
  it('U-11: connects to the eligible data-lab profile', () => {
    const dl = profile()
    expect(decideAutoConnect([localOther, dl, cloud])).toEqual({ kind: 'connect', profile: dl })
  })

  it('U-11: skips when no profile is named data-lab', () => {
    expect(decideAutoConnect([localOther, cloud])).toEqual({ kind: 'skip', reason: 'no-profile' })
  })

  it('skips when two profiles are named data-lab', () => {
    expect(decideAutoConnect([profile(), profile({ id: 'dl-2' })])).toEqual({
      kind: 'skip',
      reason: 'ambiguous'
    })
  })

  it('B-2: skips when the gRPC port is empty', () => {
    expect(decideAutoConnect([profile({ localGrpcPort: undefined })])).toEqual({
      kind: 'skip',
      reason: 'ports'
    })
  })

  it("B-2: skips when ports are Demo-RAG's", () => {
    expect(decideAutoConnect([profile({ localPort: 8080, localGrpcPort: 50051 })])).toEqual({
      kind: 'skip',
      reason: 'ports'
    })
  })

  it('skips a non-local or remote-host profile', () => {
    expect(decideAutoConnect([profile({ type: 'cloud' })])).toEqual({
      kind: 'skip',
      reason: 'not-local'
    })
    expect(decideAutoConnect([profile({ localHost: '10.0.0.5' })])).toEqual({
      kind: 'skip',
      reason: 'host'
    })
  })

  it('accepts an undefined localHost', () => {
    const dl = profile({ localHost: undefined })
    expect(decideAutoConnect([dl])).toEqual({ kind: 'connect', profile: dl })
  })
})

describe('autoConnectOnce', () => {
  beforeEach(() => __resetForTests())

  it('F-14: connect returning false is not retried, no fallback', async () => {
    const connect = vi.fn(async (_id: string) => false)
    const result = await autoConnectOnce({
      list: async () => [profile(), localOther],
      connect,
      hasActive: () => false
    })
    expect(result).toBe(false)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith('dl-1')
  })

  it('runs only once per launch, even concurrently', async () => {
    const list = vi.fn(
      () => new Promise<ConnectionConfig[]>((resolve) => setTimeout(() => resolve([profile()]), 0))
    )
    const connect = vi.fn(async (_id: string) => true)
    const d = { list, connect, hasActive: () => false }
    await Promise.all([autoConnectOnce(d), autoConnectOnce(d)])
    expect(list).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('does nothing when a connection is already active', async () => {
    const list = vi.fn(async () => [profile()])
    const connect = vi.fn(async (_id: string) => true)
    const result = await autoConnectOnce({ list, connect, hasActive: () => true })
    expect(result).toBe(false)
    expect(list).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
})
