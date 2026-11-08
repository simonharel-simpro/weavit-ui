import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/projection/**', 'src/renderer/src/features/projection/*.ts'],
      // The hook is React glue; its decisions live in pure helpers in frame.ts.
      exclude: ['**/*.test.ts', '**/*.fixtures.ts', 'src/renderer/src/features/projection/useProjectionRun.ts'],
      thresholds: { lines: 70 }
    }
  }
})
