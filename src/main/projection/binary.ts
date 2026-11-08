import path from 'node:path'

const ENV_VAR = 'WEAVIT_PROJECTOR_BIN'
const BUILD_CMD = 'pnpm projector:build'

export type BinaryStat = (p: string) => { isFile: boolean; executable: boolean } | undefined

function problem(p: string, stat: BinaryStat): string | undefined {
  const s = stat(p)
  if (!s) return 'does not exist'
  if (!s.isFile) return 'is not a file'
  if (!s.executable) return 'is not executable'
  return undefined
}

/**
 * Where the projector sidecar lives: an explicit `WEAVIT_PROJECTOR_BIN`, else
 * the cargo release build inside the app root (F-8). Pure: the caller injects
 * the file-system probe.
 */
export function resolveProjectorBinary({
  appRoot,
  env,
  platform,
  stat
}: {
  appRoot: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  stat: BinaryStat
}): { path: string } | { error: string } {
  const p = platform === 'win32' ? path.win32 : path.posix
  const override = env[ENV_VAR]
  if (override) {
    if (!p.isAbsolute(override)) {
      return { error: `${ENV_VAR} must be an absolute path, got ${override}` }
    }
    const why = problem(override, stat)
    return why ? { error: `${ENV_VAR} points at ${override}, which ${why}` } : { path: override }
  }
  const exe = platform === 'win32' ? 'weavit-projector.exe' : 'weavit-projector'
  const built = p.join(appRoot, 'native', 'projector', 'target', 'release', exe)
  const why = problem(built, stat)
  if (!why) return { path: built }
  return {
    error: `projector binary ${built} ${why} — build it with \`${BUILD_CMD}\` or set ${ENV_VAR} to an absolute path`
  }
}
