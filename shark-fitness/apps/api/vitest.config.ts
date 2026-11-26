import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // No test may reach a real host (helpers/network-guard.ts). With
    // SHARK_ROUTE_COVERAGE_LOG set, every request is logged (helpers/route-recorder.ts).
    setupFiles: ['src/__tests__/helpers/network-guard.ts', 'src/__tests__/helpers/route-recorder.ts'],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
