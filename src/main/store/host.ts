/**
 * What the JSON store needs from its runtime. The desktop app backs it with
 * Electron (userData dir, OS keychain); web mode with a plain directory and
 * in-memory secrets. Kept free of Electron imports so the web server can load it.
 */
export interface StoreHost {
  /** Directory holding the JSON files; created on first use. */
  dataDir(): string
  /** Parent of the previous app-name folders to migrate from, or null to skip migration. */
  appDataDir(): string | null
  /** Encrypt an API key to a base64 payload, or null when no encryption is available. */
  encrypt(plain: string): string | null
  decrypt(payload: string): string
  /** False: API keys live in memory for the process lifetime and never touch disk. */
  persistSecrets: boolean
}

let host: StoreHost | null = null

export function setStoreHost(next: StoreHost): void {
  host = next
}

export function storeHost(): StoreHost {
  if (!host) throw new Error('setStoreHost() must run before the store is used')
  return host
}
