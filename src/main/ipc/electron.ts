import { ipcMain } from 'electron'
import type { ProjectionSession } from '../projection/session'
import { registerHandlers } from './registry'

export function registerIpc(projection: ProjectionSession): void {
  registerHandlers(
    (channel, fn) => {
      ipcMain.handle(channel, async (_event, ...args: unknown[]) => fn(...args))
    },
    { projection }
  )
}
