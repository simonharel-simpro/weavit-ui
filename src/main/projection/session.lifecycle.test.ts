import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, deferred, disposeSessions, emitFrame, emitPca, pagesOf, range, readReq, rootRun, rows, selReq, setup, until } from './session.fixtures'

afterEach(disposeSessions)

describe('session — supersede, cancel, dispose', () => {
  it('F-5: should ignore a frame and an exit from a killed run after a new run starts', async () => {
    const t = setup({ pages: [rows(1000), []] })
    await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    const a = t.slot.run!
    t.children[0].exitOnKill = false
    t.script.push(rows(1000), deferred())
    const b = await t.s.start(readReq())
    await until(() => expect(t.spawnFn).toHaveBeenCalledTimes(2))
    const before = JSON.stringify(t.st(b.jobId))
    emitPca(t.children[0], 1000, 4, 0)
    emitFrame(t.children[0], 1000, 10)
    t.children[0].exit(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(JSON.stringify(t.st(b.jobId))).toBe(before)
    expect(a).toMatchObject({ state: 'superseded', frameVersion: 0 })
    expect(a.umap).toBeUndefined()
    expect(t.slot.contexts.has(a.runId)).toBe(false)
  })

  it('F-5: should reject a selection whose jobId is not the current dataset', async () => {
    const t = setup()
    const a = await rootRun(t, 100)
    t.script.push(deferred())
    await t.s.start(readReq())
    const spawned = vi.mocked(t.spawnFn).mock.calls.length
    await expect(t.s.start(selReq(a.jobId, range(20)))).rejects.toThrow(/no longer current/)
    expect(t.spawnFn).toHaveBeenCalledTimes(spawned)
  })

  it('F-12: should return a terminal unknown state for an unknown jobId', () => {
    const t = setup()
    expect(t.s.status('nope')).toEqual({ jobId: 'nope', state: 'unknown' })
  })

  it('F-13: should kill the running child when the session is disposed', async () => {
    const t = setup({ pages: [rows(100)] })
    await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    t.s.dispose()
    expect(t.children[0].kill).toHaveBeenCalled()
  })

  it('U-15: should keep the last frame after cancel and report the stage', async () => {
    const t = setup({ pages: [rows(100)] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    emitPca(t.children[0], 100, 4, 0)
    emitFrame(t.children[0], 100, 10)
    emitFrame(t.children[0], 100, 20)
    t.s.cancel(jobId)
    const after = t.st(jobId)
    expect(after).toMatchObject({ state: 'cancelled', umap: { epoch: 20 }, stage: 'epochs' })
    t.s.cancel(jobId)
    await new Promise((r) => setTimeout(r, 10))
    expect(t.st(jobId)).toEqual(after)
  })

  it('U-30: should reject a selection after a cancelled read', async () => {
    const page2 = deferred()
    const t = setup({ pages: [rows(1000), page2] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(1000))
    t.s.cancel(jobId)
    page2.resolve(rows(1000, 4, 1000))
    await until(() => expect(t.slot.dataset?.complete).toBe(false))
    await expect(t.s.start(selReq(jobId, range(20)))).rejects.toThrow('read was cancelled — Run again to select')
  })

  it('U-51: should serve points for a cancelled read', async () => {
    const page3 = deferred()
    const t = setup({ pages: [...pagesOf(2000), page3] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(2000))
    t.s.cancel(jobId)
    page3.resolve(rows(1000, 4, 2000))
    await until(() => expect(t.slot.dataset).toBeDefined())
    const s = t.st(jobId, { points: true })
    expect(s).toMatchObject({ state: 'cancelled', readComplete: false })
    expect(s.points?.uuids.length).toBe(2000)
  })

  it('U-51: should keep the partial dataset when a cancel interrupts a pending write', async () => {
    const t = setup({ pages: [rows(1000), rows(1000, 4, 1000)], stall: true })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.children[0]?.held.length).toBe(1))
    t.s.cancel(jobId)
    await until(() => expect(t.slot.dataset).toBeDefined())
    expect(t.st(jobId).state).toBe('cancelled')
    expect(t.st(jobId, { points: true }).points?.uuids.length).toBe(1000)
  })

  it('U-51: should drop the dataset when the read fails', async () => {
    const t = setup({ pages: [...pagesOf(2000), new Error('boom')] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.st(jobId).readComplete).toBe(false)
    expect(t.slot.dataset).toBeUndefined()
    expect(t.st(jobId, { points: true }).points).toBeUndefined()

    // The child dies mid-read, then the read itself ends normally.
    const last = deferred()
    t.script.push(rows(1000), last)
    const mid = await t.s.start(readReq())
    await until(() => expect(t.st(mid.jobId).n).toBe(1000))
    t.children.at(-1)!.exit(1)
    await until(() => expect(t.st(mid.jobId).state).toBe('failed'))
    last.resolve([])
    await new Promise((r) => setTimeout(r, 10))
    expect(t.st(mid.jobId).readComplete).toBe(false)
    expect(t.slot.dataset).toBeUndefined()

    t.script.push(rows(100))
    const b = await t.s.start(readReq())
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    t.children.at(-1)!.exit(1)
    await until(() => expect(t.st(b.jobId).state).toBe('failed'))
    expect(t.st(b.jobId).readComplete).toBe(true)
    expect(t.st(b.jobId, { points: true }).points?.uuids.length).toBe(100)
  })

  it('U-46: should keep the newer of two racing starts', async () => {
    const t = setup({ pages: [rows(100)] })
    let releaseA!: () => void
    let releaseB!: () => void
    vi.mocked(t.deps.getConfig)
      .mockImplementationOnce(() => new Promise((r) => (releaseA = () => r(config()))))
      .mockImplementationOnce(() => new Promise((r) => (releaseB = () => r(config()))))
    const a = t.s.start(readReq())
    const b = t.s.start(readReq())
    releaseB()
    const bIds = await b
    releaseA()
    await expect(a).rejects.toThrow('superseded by a newer start')
    expect(t.slot.run?.runId).toBe(bIds.runId)
    await until(() => expect(t.spawnFn).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(t.spawnFn).toHaveBeenCalledTimes(1)
  })
})
