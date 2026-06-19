import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*_test.ts'],
    restoreMocks: false,
    // 30s default: control-plane route tests use `setupAppTest` which spins
    // up the full Hono app + memory D1 mock + admin session per test. Real
    // work is hundreds of milliseconds but under workspace-parallel load
    // (worker contention + GC pauses) several push past vitest's 10s
    // default and flake intermittently. 30s gives headroom without masking
    // actual hangs.
    testTimeout: 30_000,
    setupFiles: ['./vitest.setup.ts'],
  },
});
