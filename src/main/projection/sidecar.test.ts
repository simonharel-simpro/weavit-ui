import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidecarMessage } from './protocol'
import { startSidecar, type SidecarOutcome, type SpawnFn } from './sidecar'

const HEADER = {
  protocol: 1,
  nMax: 10,
  dim: 2,
  method: 'umap',
  dims: 2,
  pcaDims: 50,
  nNeighbors: 15,
  minDist: 0.1,
  epochs: 200,
  seed: 42,
  frameEvery: 10,
  batchRows: 1000,
  fitRows: 10_000
} as const
const HELLO = '{"type":"hello","protocol":1}\n'
const PROGRESS = '{"type":"progress","stage":"pca","done":1,"total":2}\n'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid: number | undefined = 4242
  /** When true, a kill makes the fake exit on the next microtask, like a real child. */
  exitOnKill = true
  kill = vi.fn((signal?: NodeJS.Signals) => {
    if (this.exitOnKill) queueMicrotask(() => this.exit(null, signal ?? 'SIGTERM'))
    return true
  })
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
  out(s: string): void {
    this.stdout.emit('data', Buffer.from(s))
  }
}

function start(over: { watchdogMs?: number; killGraceMs?: number } = {}) {
  const child = new FakeChild()
  const spawnFn = vi.fn(() => child) as unknown as SpawnFn
  const sc = startSidecar({ path: '/bin/wp', header: HEADER, spawnFn, ...over })
  const messages: SidecarMessage[] = []
  sc.onMessage((m) => messages.push(m))
  const outcome = new Promise<SidecarOutcome>((resolve) => sc.onClose(resolve))
  return { child, spawnFn, sc, messages, outcome }
}
const failed = async (o: Promise<SidecarOutcome>): Promise<string> => {
  const r = await o
  if (r.ok) throw new Error('expected a failed outcome')
  return r.error
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startSidecar — spawn and success', () => {
  it('spawns with array args and no shell, then writes the header line', () => {
    const { child, spawnFn } = start()
    expect(spawnFn).toHaveBeenCalledWith('/bin/wp', [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const first = String(child.stdin.read())
    expect(JSON.parse(first)).toMatchObject({ protocol: 1, nMax: 10, dim: 2 })
  })

  it('reports ok with n once done is seen and the child exits 0', async () => {
    const { child, outcome, messages } = start()
    child.out(HELLO + '{"type":"done","n":3}\n')
    child.exit(0)
    expect(await outcome).toEqual({ ok: true, n: 3 })
    expect(messages.map((m) => m.type)).toEqual(['hello', 'done'])
  })

  it('still calls an onClose registered after the close', async () => {
    const { child, sc } = start()
    child.exit(0)
    await expect(new Promise((resolve) => sc.onClose(resolve))).resolves.toMatchObject({ ok: false })
  })
})

describe('startSidecar — protocol (F-9, F-10)', () => {
  it('F-10: should fail on a non-JSON stdout line', async () => {
    const { child, outcome } = start()
    child.out(HELLO + 'oops\n')
    expect(await failed(outcome)).toMatch(/^protocol error/)
  })

  it("F-10: should fail when a frame's coords length is not n*dims", async () => {
    const { child, outcome } = start()
    const seven = Buffer.from(new Float32Array(7).buffer).toString('base64')
    child.out(HELLO + `{"type":"frame","stage":"umap","epoch":1,"epochs":2,"dims":2,"n":4,"coords":"${seven}"}\n`)
    expect(await failed(outcome)).toMatch(/^protocol error/)
  })

  it('F-9: should fail with a rebuild hint when hello.protocol differs', async () => {
    const { child, outcome, messages } = start()
    child.out('{"type":"hello","protocol":2}\n' + PROGRESS)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(messages).toEqual([])
    expect(await failed(outcome)).toContain('pnpm projector:build')
  })

  it('F-10: should kill the child on the first protocol error', async () => {
    const { child, outcome, messages } = start()
    child.out(HELLO + 'oops\n' + PROGRESS)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(messages.map((m) => m.type)).toEqual(['hello'])
    child.out(PROGRESS)
    expect(messages.map((m) => m.type)).toEqual(['hello'])
    await outcome
  })
})

describe('startSidecar — writes (F-4)', () => {
  it('F-4: should not hang waiting for drain when the child exits', async () => {
    const { child, sc } = start()
    child.stdin.write = (() => false) as typeof child.stdin.write
    const w = sc.write(new Uint8Array(8))
    const t0 = Date.now()
    setTimeout(() => child.exit(1), 10)
    await expect(w).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(100)
  })

  it('F-4: should reject the write, not throw, on EPIPE', async () => {
    const { child, sc } = start()
    child.stdin.write = (() => false) as typeof child.stdin.write
    const w = sc.write(new Uint8Array(8))
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await expect(w).rejects.toThrow('EPIPE')
    await expect(sc.write(new Uint8Array(8))).rejects.toThrow()
  })

  it('resolves a backpressured write on drain', async () => {
    const { child, sc } = start()
    child.stdin.write = (() => false) as typeof child.stdin.write
    const w = sc.write(new Uint8Array(8))
    child.stdin.emit('drain')
    await expect(w).resolves.toBeUndefined()
  })

  it('rejects a write after end()', async () => {
    const { sc } = start()
    sc.end()
    await expect(sc.write(new Uint8Array(4))).rejects.toThrow()
  })
})

describe('startSidecar — outcome (F-6)', () => {
  it('F-6: should carry the stderr tail of a panic', async () => {
    const { child, outcome } = start()
    child.stderr.emit('data', Buffer.from("thread 'main' panicked at src/umap_run.rs:42:5\n"))
    child.exit(1)
    const error = await failed(outcome)
    expect(error).toContain('exited with code 1')
    expect(error).toContain('panicked at')
  })

  it('F-6: should fail an exit 0 without done', async () => {
    const { child, outcome } = start()
    child.out(HELLO)
    child.exit(0)
    expect(await outcome).toMatchObject({ ok: false })
  })

  it('F-6: should name SIGKILL', async () => {
    const { child, outcome } = start()
    child.exit(null, 'SIGKILL')
    expect(await failed(outcome)).toContain('SIGKILL')
  })

  it("reports the child's error message", async () => {
    const { child, outcome } = start()
    child.out(HELLO + '{"type":"error","message":"input ended mid-row"}\n')
    child.exit(1)
    expect(await failed(outcome)).toBe('input ended mid-row')
  })

  it('reports a spawn failure', async () => {
    const { child, outcome } = start()
    child.pid = undefined
    child.emit('error', new Error('spawn /bin/wp ENOENT'))
    expect(await failed(outcome)).toContain('ENOENT')
  })
})

describe('startSidecar — kill and watchdog (F-7, U-43)', () => {
  it('kill sends SIGTERM, then SIGKILL after the grace period', async () => {
    vi.useFakeTimers()
    const { child, sc, outcome } = start({ killGraceMs: 5000 })
    child.exitOnKill = false
    sc.kill('cancelled')
    expect(child.kill).toHaveBeenLastCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(5001)
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    child.exit(null, 'SIGKILL')
    expect(await failed(outcome)).toBe('cancelled')
  })

  it('F-7: should kill the child after 60 s without a stdout line', async () => {
    vi.useFakeTimers()
    const { child, outcome } = start()
    child.out(HELLO)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(child.kill).toHaveBeenCalled()
    expect(await failed(outcome)).toBe('no output for 60 s')
  })

  it('U-43: should not trip the watchdog while the host is still writing', async () => {
    vi.useFakeTimers()
    const { child, sc, outcome } = start()
    child.out(HELLO)
    for (let i = 0; i < 10; i++) {
      await sc.write(new Uint8Array(8))
      await vi.advanceTimersByTimeAsync(7000)
    }
    child.out(PROGRESS)
    expect(child.kill).not.toHaveBeenCalled()
    sc.end()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(child.kill).toHaveBeenCalled()
    expect(await failed(outcome)).toBe('no output for 60 s')
  })
})

