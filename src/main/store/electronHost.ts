import { app, safeStorage } from 'electron'
import type { StoreHost } from './host'

export const electronHost: StoreHost = {
  dataDir: () => app.getPath('userData'),
  appDataDir: () => app.getPath('appData'),
  encrypt: (plain) =>
    safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain).toString('base64') : null,
  decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
  persistSecrets: true
}
