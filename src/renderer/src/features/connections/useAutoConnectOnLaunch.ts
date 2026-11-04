import { useEffect } from 'react'
import { api } from '../../lib/api'
import { useConnect } from '../../lib/useConnect'
import { useApp } from '../../store'
import { autoConnectOnce } from './autoConnect'

// The only auto-connect file that touches api/React/the store; the policy lives
// in autoConnect.ts so it stays unit-testable in the node test environment.
export function useAutoConnectOnLaunch(): void {
  const connect = useConnect()

  // WHY: one-shot connect after launch; autoConnectOnce's module flag makes the
  // StrictMode double effect (and any re-render) a no-op, so deps stay empty.
  useEffect(() => {
    autoConnectOnce({
      list: api.connections.list,
      connect,
      hasActive: () => !!useApp.getState().activeConnectionId,
      onSkip: (r) => console.info('autoconnect skip:', r)
    }).catch(console.error)
  }, [])
}
