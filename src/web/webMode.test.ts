import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setStoreHost } from '../main/store/host'
import { getSecret, hasSecret, loadConnections, saveConnections, setSecret } from '../main/store/store'
import { decideAutoConnect } from '../renderer/src/features/connections/autoConnect'
import { seedDataLabProfile } from './seed'
import { webHost } from './webHost'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weavit-store-'))
  setStoreHost(webHost(dir))
})

describe('web store host', () => {
  it('keeps API keys in memory and never writes them to disk', () => {
    setSecret('conn-1', 'sk-very-secret')

    expect(getSecret('conn-1')).toBe('sk-very-secret')
    expect(hasSecret('conn-1')).toBe(true)
    expect(existsSync(join(dir, 'weft-secrets.json'))).toBe(false)
  })

  it('clears a key when asked', () => {
    setSecret('conn-1', 'k')
    setSecret('conn-1', null)
    expect(hasSecret('conn-1')).toBe(false)
  })

  it('stores profiles as JSON in its data dir', () => {
    saveConnections([{ id: 'a', name: 'x', type: 'local', authType: 'none' }])
    expect(JSON.parse(readFileSync(join(dir, 'weft-connections.json'), 'utf-8'))).toHaveLength(1)
  })
})

describe('seedDataLabProfile', () => {
  it('creates a profile that auto-connect accepts', () => {
    expect(seedDataLabProfile()).toBe(true)

    const decision = decideAutoConnect(loadConnections())
    expect(decision.kind).toBe('connect')
  })

  it('never adds a second data-lab profile or touches an existing one', () => {
    const mine = { id: 'mine', name: 'data-lab', type: 'local' as const, authType: 'none' as const, localPort: 1 }
    saveConnections([mine])

    expect(seedDataLabProfile()).toBe(false)
    expect(loadConnections()).toEqual([mine])
  })
})
