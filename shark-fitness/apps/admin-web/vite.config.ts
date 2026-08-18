import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwind()],
  build: {
    rollupOptions: {
      output: {
        // Only two vendor groups, both chosen because they are large, shared
        // by every route and change far less often than app code — so they
        // keep their long-lived cache entry across deploys that rewrite the
        // app chunks. Everything else (zod, zustand, idb) is small or needed
        // at boot anyway, and splitting it would just add requests.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (id.includes('@tanstack')) return 'tanstack-vendor';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: /^@shark\/contracts$/, replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: /^@shark\/domain$/, replacement: fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) },
      { find: /^@shark\/design-tokens$/, replacement: fileURLToPath(new URL('../../packages/design-tokens/src/index.ts', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
});
