import { describe, expect, it } from 'vitest'
import { resolveProjectorBinary } from './binary'

type Stat = { isFile: boolean; executable: boolean } | undefined
const statOf =
  (files: Record<string, Stat>) =>
  (p: string): Stat =>
    files[p]

const DEFAULT = '/app/native/projector/target/release/weavit-projector'

describe('resolveProjectorBinary', () => {
  it('F-8: should name the env var, the path and the build command when the binary is missing', () => {
    const r = resolveProjectorBinary({ appRoot: '/app', env: {}, platform: 'linux', stat: statOf({}) })
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error).toContain('WEAVIT_PROJECTOR_BIN')
    expect(r.error).toContain(DEFAULT)
    expect(r.error).toContain('pnpm projector:build')
  })

  it('F-8: should append .exe on win32', () => {
    const r = resolveProjectorBinary({
      appRoot: 'C:\\app',
      env: {},
      platform: 'win32',
      stat: () => ({ isFile: true, executable: true })
    })
    if (!('path' in r)) throw new Error('expected a path')
    expect(r.path.endsWith('.exe')).toBe(true)
  })

  it('F-8: should reject an env override that points at a directory', () => {
    const r = resolveProjectorBinary({
      appRoot: '/app',
      env: { WEAVIT_PROJECTOR_BIN: '/opt/projector' },
      platform: 'linux',
      stat: statOf({ '/opt/projector': { isFile: false, executable: true } })
    })
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error).toContain('WEAVIT_PROJECTOR_BIN')
    expect(r.error).toContain('/opt/projector')
  })

  it('uses a valid env override', () => {
    const r = resolveProjectorBinary({
      appRoot: '/app',
      env: { WEAVIT_PROJECTOR_BIN: '/opt/wp' },
      platform: 'linux',
      stat: statOf({ '/opt/wp': { isFile: true, executable: true } })
    })
    expect(r).toEqual({ path: '/opt/wp' })
  })

  it('rejects a relative env override and a non-executable file', () => {
    const exec = { isFile: true, executable: true }
    const relative = resolveProjectorBinary({
      appRoot: '/app',
      env: { WEAVIT_PROJECTOR_BIN: 'bin/wp' },
      platform: 'linux',
      stat: () => exec
    })
    expect(relative).toHaveProperty('error', expect.stringContaining('absolute'))
    const notExec = resolveProjectorBinary({
      appRoot: '/app',
      env: {},
      platform: 'linux',
      stat: statOf({ [DEFAULT]: { isFile: true, executable: false } })
    })
    expect(notExec).toHaveProperty('error', expect.stringContaining('not executable'))
  })

  it('resolves the default build output', () => {
    const r = resolveProjectorBinary({
      appRoot: '/app',
      env: {},
      platform: 'linux',
      stat: statOf({ [DEFAULT]: { isFile: true, executable: true } })
    })
    expect(r).toEqual({ path: DEFAULT })
  })
})
