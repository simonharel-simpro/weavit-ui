import { ipcMain } from 'electron'
import { registerHandlers } from './registry'

export function registerIpc(): void {
  registerHandlers((channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => fn(...args))
  })
}
