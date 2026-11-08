// The only module that spawns a child process (guards.test.ts enforces it):
// runs the weavit-projector sidecar, streams rows in, parses NDJSON out, and
// decides one outcome when the child closes (F-6).
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { errorMessage } from '../util'
import { encodeHeader, LineSplitter, parseMessage, PROTOCOL, type Header, type SidecarMessage } from './protocol'

export type SpawnFn = typeof import('node:child_process').spawn
export type SidecarOutcome = { ok: true; n: number } | { ok: false; error: string }
export interface Sidecar {
  write(buf: Uint8Array): Promise<void>
  end(): void
  kill(reason?: string): void
  onMessage(cb: (m: SidecarMessage) => void): void
  onClose(cb: (o: SidecarOutcome) => void): void
}

type Child = ChildProcessByStdio<Writable, Readable, Readable>
const STDERR_TAIL = 8 * 1024
const REBUILD = 'rebuild: pnpm projector:build'

class SidecarProcess implements Sidecar {
  private readonly splitter = new LineSplitter()
  private readonly msgCbs: ((m: SidecarMessage) => void)[] = []
  private readonly closeCbs: ((o: SidecarOutcome) => void)[] = []
  private readonly waiters = new Set<(e: Error) => void>()
  private outcome: SidecarOutcome | undefined
  private helloSeen = false
  /** Set on the first protocol error or hello mismatch: nothing more is parsed. */
  private fatal: string | undefined
  private killReason: string | undefined
  private doneN: number | undefined
  private childError: string | undefined
  private stderrTail = ''
  private broken: Error | undefined
  private ended = false
  private exited = false
  private killing = false
  private watchdog: ReturnType<typeof setTimeout> | undefined
  private grace: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly child: Child,
    private readonly watchdogMs: number,
    private readonly killGraceMs: number
  ) {
    child.on('error', (e) => {
      this.breakStdin(e)
      if (child.pid === undefined) this.finish({ ok: false, error: `failed to start the projector: ${errorMessage(e)}` })
    })
    child.on('exit', () => {
      this.exited = true
      clearTimeout(this.grace)
      this.breakStdin(new Error('the projector exited'))
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => this.finish(this.decide(code, signal)))
    child.stdin.on('error', (e) => this.breakStdin(e))
    child.stdout.on('error', (e) => this.breakStdin(e))
    child.stderr.on('error', () => {}) // the tail is best-effort diagnostics
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL)
    })
    this.armWatchdog()
  }

  write(buf: Uint8Array): Promise<void> {
    if (this.broken) return Promise.reject(new Error(`projector stdin is closed: ${this.broken.message}`))
    if (this.ended) return Promise.reject(new Error('projector stdin was already ended'))
    return new Promise((resolve, reject) => {
      const flushed = (): void => {
        this.waiters.delete(fail)
        if (!this.ended) this.armWatchdog() // U-43: a slow read is not a silent child
        resolve()
      }
      const fail = (e: Error): void => {
        this.child.stdin.off('drain', flushed)
        this.waiters.delete(fail)
        reject(e)
      }
      if (this.child.stdin.write(buf)) return flushed()
      this.waiters.add(fail)
      this.child.stdin.once('drain', flushed)
    })
  }

  end(): void {
    this.ended = true
    if (!this.broken) this.child.stdin.end()
  }

  kill(reason?: string): void {
    this.killReason ??= reason
    clearTimeout(this.watchdog)
    if (this.killing || this.exited) return
    this.killing = true
    this.child.kill('SIGTERM')
    this.grace = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL')
    }, this.killGraceMs)
  }

  onMessage(cb: (m: SidecarMessage) => void): void {
    this.msgCbs.push(cb)
  }

  onClose(cb: (o: SidecarOutcome) => void): void {
    const decided = this.outcome
    if (decided) queueMicrotask(() => cb(decided))
    else this.closeCbs.push(cb)
  }

  private onStdout(chunk: Buffer): void {
    if (this.fatal !== undefined) return
    let lines: string[]
    try {
      lines = this.splitter.push(chunk)
    } catch (e) {
      return this.die(`protocol error: ${errorMessage(e)}`)
    }
    for (const line of lines) {
      this.armWatchdog()
      let m: SidecarMessage
      try {
        m = parseMessage(line)
      } catch (e) {
        return this.die(this.helloSeen ? `protocol error: ${errorMessage(e)}` : this.helloMismatch())
      }
      if (!this.helloSeen) {
        if (m.type !== 'hello' || m.protocol !== PROTOCOL) return this.die(this.helloMismatch(m))
        this.helloSeen = true
      }
      if (m.type === 'done') this.doneN = m.n
      if (m.type === 'error') this.childError = m.message
      for (const cb of this.msgCbs) cb(m)
    }
  }

  /** F-9: the first line must be hello with our protocol version. */
  private helloMismatch(m?: SidecarMessage): string {
    if (m?.type === 'hello') return `projector protocol ${m.protocol}, host expects ${PROTOCOL} — ${REBUILD}`
    return `projector did not announce protocol ${PROTOCOL} on its first line — ${REBUILD}`
  }

  private die(message: string): void {
    this.fatal = message
    this.kill()
  }

  /** Outcome precedence: protocol failure, clean done, host kill reason, child error, signal, exit code. */
  private decide(code: number | null, signal: NodeJS.Signals | null): SidecarOutcome {
    if (this.fatal !== undefined) return { ok: false, error: this.fatal }
    if (this.doneN !== undefined && code === 0) return { ok: true, n: this.doneN }
    if (this.killReason !== undefined) return { ok: false, error: this.killReason }
    if (this.childError !== undefined) return { ok: false, error: this.childError }
    const tail = this.stderrTail.trim()
    const base = signal ? `killed by ${signal}` : `exited with code ${code}${code === 0 ? ' without done' : ''}`
    return { ok: false, error: tail ? `${base}: ${tail}` : base }
  }

  private finish(o: SidecarOutcome): void {
    if (this.outcome) return
    this.outcome = o
    clearTimeout(this.watchdog)
    clearTimeout(this.grace)
    this.breakStdin(new Error('the projector closed'))
    for (const cb of this.closeCbs.splice(0)) cb(o)
  }

  private breakStdin(e: Error): void {
    this.broken ??= e
    for (const fail of [...this.waiters]) fail(e)
  }

  /** F-7: no stdout line (or, before end(), no flushed host write) for watchdogMs → kill. */
  private armWatchdog(): void {
    if (this.outcome || this.killing) return
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => this.kill(`no output for ${this.watchdogMs / 1000} s`), this.watchdogMs)
  }
}

export function startSidecar(o: {
  path: string
  header: Header
  spawnFn?: SpawnFn
  watchdogMs?: number
  killGraceMs?: number
}): Sidecar {
  const spawnFn = o.spawnFn ?? spawn
  // Array args and no shell: the path is never parsed by a shell.
  const child = spawnFn(o.path, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const sc = new SidecarProcess(child, o.watchdogMs ?? 60_000, o.killGraceMs ?? 5_000)
  sc.write(new TextEncoder().encode(encodeHeader(o.header))).catch(() => {
    // A failed header write surfaces through the close outcome.
  })
  return sc
}
