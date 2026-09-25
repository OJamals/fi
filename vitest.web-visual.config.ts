import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Opt-in pixel-baseline visual lane: separate from vitest.web.config.ts (the
// required test:web gate) so a pixel diff never blocks a PR on noise this
// repo has not yet had to tune project-wide. Boots the same real composition
// as the e2e lane over apps/web/tests/scaffold.ts; see
// apps/web/visual/gui-surfaces.visual.ts for the determinism techniques and
// docs/testing.md for the recording workflow.
try {
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ['./tsconfig.base.json'] }),
    standardDecoratorPlugin(),
  ],
  test: {
    execArgv: vitestExecArgv,
    include: ['apps/web/visual/**/*.visual.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
