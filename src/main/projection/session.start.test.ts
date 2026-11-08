import { afterEach, describe, expect, it } from 'vitest'
import { builtF, deferred, disposeSessions, F, finish, pagesOf, readReq, rows, setup, until } from './session.fixtures'

afterEach(disposeSessions)

describe('session — start and read', () => {
  it('session: start resolves before the read completes', async () => {
    const t = setup({ pages: [deferred()] })
    const ids = await t.s.start(readReq())
    expect(ids).toEqual({ jobId: expect.any(String), runId: expect.any(String) })
    expect(t.st(ids.jobId).state).toBe('reading')
  })

  it('session: spawns after page 1 with nMax = cap and dim = D', async () => {
    const t = setup({ pages: [rows(1000, 384), deferred()] })
    await t.s.start(readReq({ limit: 5000 }))
    await until(() => expect(t.children[0]?.header).toBeDefined())
    expect(t.fetchesAtSpawn).toEqual([1])
    expect(t.children[0].header).toMatchObject({ nMax: 5000, dim: 384, method: 'umap', dims: 2 })
  })

  it('F-8: should not read when the binary is unresolvable', async () => {
    const t = setup({ stat: () => undefined })
    await expect(t.s.start(readReq())).rejects.toThrow(/does not exist — build it with `pnpm projector:build`/)
    expect(t.fetchObjects).not.toHaveBeenCalled()
  })

  it('F-1: should start a run when the aggregate count throws', async () => {
    const t = setup({ pages: [rows(1000), deferred()], overAll: () => Promise.reject(new Error('aggregate down')) })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(1000))
    expect(t.st(jobId).state).toBe('reading')
    expect(t.st(jobId).progress?.total).toBeUndefined()
  })

  it('F-3: should fail the run, not finish it, when a filtered page throws', async () => {
    const msg = 'query maximum results exceeded'
    const t = setup({ pages: [...pagesOf(3000), new Error(msg)] })
    const { jobId } = await t.s.start(readReq({ filters: F }))
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.st(jobId).error).toContain(msg)
    expect(t.children[0].kill).toHaveBeenCalled()
    finish(t.children[0], 3000)
    expect(t.st(jobId).state).toBe('failed')
  })

  it('F-4: should fail the run and keep the host alive when the child closes stdin mid-stream', async () => {
    const page2 = deferred()
    const t = setup({ pages: [rows(1000), page2] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(1000))
    t.children[0].stdin.destroy(new Error('write EPIPE'))
    page2.resolve(rows(1000, 4, 1000))
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.fetchObjects).toHaveBeenCalledTimes(2)
  })

  it('F-7: should fail the run and kill the child when a page read rejects', async () => {
    const t = setup({ pages: [rows(1000), new Error('connection reset')] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).state).toBe('failed'))
    expect(t.st(jobId).error).toBe('connection reset')
    expect(t.children[0].kill).toHaveBeenCalled()
  })

  it('F-18: should finish as empty without spawning when the read returns 0 rows / U-9: should not spawn the sidecar for an empty read', async () => {
    const t = setup({ pages: [[]] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).state).toBe('empty'))
    expect(t.st(jobId).n).toBe(0)
    expect(t.spawnFn).not.toHaveBeenCalled()
  })

  it('status: n and readComplete mid-read', async () => {
    const page3 = deferred()
    const t = setup({ pages: [...pagesOf(2000), page3] })
    const { jobId } = await t.s.start(readReq())
    await until(() => expect(t.st(jobId).n).toBe(2000))
    expect(t.st(jobId).readComplete).toBe(false)
    page3.resolve([])
    await until(() => expect(t.st(jobId).readComplete).toBe(true))
  })

  it('U-40: should pass the filters to the count', async () => {
    const t = setup({ pages: [rows(500)], overAll: async () => ({ totalCount: 500 }) })
    await t.s.start(readReq({ filters: F }))
    await until(() => expect(t.overAll).toHaveBeenCalledTimes(1))
    expect(t.overAll.mock.calls[0]).toEqual([{ filters: builtF }])
    await until(() => expect(t.slot.run?.state).toBe('computing'))
    expect(t.slot.run?.progress?.total).toBe(500)
    t.script.push(rows(10))
    await t.s.start(readReq())
    await until(() => expect(t.overAll).toHaveBeenCalledTimes(2))
    expect(t.overAll.mock.calls[1][0]).toBeUndefined()
  })
})
