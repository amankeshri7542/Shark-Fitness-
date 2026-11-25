import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // No test may reach a real host (helpers/network-guard.ts).
    setupFiles: ['src/__tests__/helpers/network-guard.ts'],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
