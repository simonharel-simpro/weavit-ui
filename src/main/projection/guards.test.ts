import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CHILD_PROCESS = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/

function sources(): string[] {
  return readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => relative(ROOT, join(ROOT, 'src', f)).split(sep).join('/'))
}

describe('guards', () => {
  it('guards: child_process only in sidecar.ts', () => {
    const importers = sources().filter((f) => CHILD_PROCESS.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(importers).toEqual(['src/main/projection/sidecar.ts'])
  })
})
