// Pure auto-connect policy for launch. Imports ONLY @shared/types: anything
// that reaches lib/api.ts reads `window` at load and crashes the node-env tests.
import type { ConnectionConfig } from '@shared/types'

/** The only profile name auto-connect will ever consider. */
export const AUTOCONNECT_PROFILE_NAME = 'data-lab'

/** Must match data-lab `compose.yaml`. Required explicitly: an empty port falls
 *  back to 8080/50051 in connectionManager.ts, which are Demo-RAG's ports. */
export const DATALAB_PORTS = { http: 8090, grpc: 50052 }

// undefined host is accepted: connectionManager.ts resolves it to 'localhost'.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost'])

export type AutoConnectSkipReason = 'no-profile' | 'ambiguous' | 'not-local' | 'host' | 'ports'

export type AutoConnectDecision =
  | { kind: 'connect'; profile: ConnectionConfig }
  | { kind: 'skip'; reason: AutoConnectSkipReason }

export interface AutoConnectDeps {
  list: () => Promise<ConnectionConfig[]>
  connect: (id: string) => Promise<boolean>
  hasActive: () => boolean
  onSkip?: (reason: AutoConnectSkipReason) => void
}

const skip = (reason: AutoConnectSkipReason): AutoConnectDecision => ({ kind: 'skip', reason })

export function decideAutoConnect(profiles: ConnectionConfig[]): AutoConnectDecision {
  const named = profiles.filter((p) => p.name === AUTOCONNECT_PROFILE_NAME)
  if (named.length === 0) return skip('no-profile')
  if (named.length > 1) return skip('ambiguous')
  const p = named[0]
  if (p.type !== 'local') return skip('not-local')
  if (p.localHost !== undefined && !LOCAL_HOSTS.has(p.localHost)) return skip('host')
  if (p.localPort !== DATALAB_PORTS.http || p.localGrpcPort !== DATALAB_PORTS.grpc) {
    return skip('ports')
  }
  return { kind: 'connect', profile: p }
}

let started = false

/** One attempt per launch. A `false` from connect (failure already surfaced by
 *  useConnect) is final: no retry, no other profile. */
export async function autoConnectOnce(deps: AutoConnectDeps): Promise<boolean> {
  if (started) return false
  // Set before the first await so overlapping calls (StrictMode) cannot both pass.
  started = true
  if (deps.hasActive()) return false
  const decision = decideAutoConnect(await deps.list())
  if (decision.kind === 'skip') {
    deps.onSkip?.(decision.reason)
    return false
  }
  return await deps.connect(decision.profile.id)
}

export function __resetForTests(): void {
  started = false
}
