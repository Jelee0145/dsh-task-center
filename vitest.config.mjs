import { defineConfig } from 'vitest/config'

/**
 * The `forks` pool is Vitest's default, but it starts each test file with
 * `child_process.fork` over piped stdio, which a sandboxed process cannot do.
 * The `threads` pool keeps every worker inside this process, so the suite runs
 * under the file sandbox without widening it. Run the suite through
 * `tools/vitest-preload.mjs` as well; see that file for the other half.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'threads',
  },
})
