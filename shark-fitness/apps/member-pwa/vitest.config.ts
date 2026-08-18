import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Component tests run through their own config rather than vite.config.ts so
 * the PWA/Tailwind plugins stay out of the test pipeline. The aliases have to
 * mirror the build config, or a test would resolve @shark/* through a
 * different path than production does.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: /^@shark\/contracts$/, replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: /^@shark\/domain$/, replacement: fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) },
      { find: /^@shark\/design-tokens$/, replacement: fileURLToPath(new URL('../../packages/design-tokens/src/index.ts', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
