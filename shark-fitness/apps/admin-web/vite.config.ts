import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shark/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@shark/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      '@shark/design-tokens': fileURLToPath(new URL('../../packages/design-tokens/src/index.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
});
