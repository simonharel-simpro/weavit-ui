import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StoreHost } from '../main/store/host'

/** Web mode: profiles in a plain directory; API keys never written to disk. */
export function webHost(dataDir: string = process.env['WEAVIT_DATA_DIR'] || defaultDataDir()): StoreHost {
  return {
    dataDir: () => dataDir,
    appDataDir: () => null,
    encrypt: () => null,
    decrypt: () => {
      throw new Error('web mode stores no encrypted secrets')
    },
    persistSecrets: false
  }
}

function defaultDataDir(): string {
  return join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'weavit-web')
}
