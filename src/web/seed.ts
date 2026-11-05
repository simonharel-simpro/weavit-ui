import { randomUUID } from 'node:crypto'
import type { ConnectionConfig } from '@shared/types'
import { AUTOCONNECT_PROFILE_NAME, DATALAB_PORTS } from '../renderer/src/features/connections/autoConnect'
import { loadConnections, saveConnections } from '../main/store/store'

/** Adds the `data-lab` profile auto-connect looks for, unless one already exists.
 *  Returns true when it created the profile. */
export function seedDataLabProfile(): boolean {
  const list = loadConnections()
  if (list.some((c) => c.name === AUTOCONNECT_PROFILE_NAME)) return false
  const profile: ConnectionConfig = {
    id: randomUUID(),
    name: AUTOCONNECT_PROFILE_NAME,
    type: 'local',
    authType: 'none',
    localHost: '127.0.0.1',
    localPort: DATALAB_PORTS.http,
    localGrpcPort: DATALAB_PORTS.grpc
  }
  saveConnections([...list, profile])
  return true
}
