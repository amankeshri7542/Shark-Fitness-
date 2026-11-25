import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

/** Ports stay overridable for machines that run several copies at once. */
const DEV_PORT = Number(process.env.SHARK_ADMIN_DEV_PORT ?? 5174);
const API_DEV_ORIGIN = process.env.SHARK_API_DEV_ORIGIN ?? 'http://localhost:8787';

export default defineConfig({
  base: '/admin/',
  plugins: [
    react(),
    tailwind(),
    // Installable on reception tablets (PHASE-PLAN decision 3). The worker
    // caches the shell only; see src/sw/sw.ts.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      scope: '/admin/',
      includeManifestIcons: false,
      manifest: {
        id: '/admin/',
        scope: '/admin/',
        start_url: '/admin/?source=pwa',
        name: 'Shark Fitness Console',
        short_name: 'Shark Ops',
        description: 'Front desk, members, schedule and billing for your gym.',
        lang: 'en-IN',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        // Reception tablets live in landscape; phones in portrait.
        orientation: 'any',
        theme_color: '#04080b',
        background_color: '#04080b',
        categories: ['business', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // The shell only: entry, vendors, styles, fonts, the offline page.
        // Screens load from the network like the data they show.
        globPatterns: [
          // Not index.html: pages always come from the network (src/sw/sw.ts).
          'offline.html',
          'assets/index-*.{js,css}',
          'assets/*-vendor-*.js',
          'assets/*.woff2',
          'favicon.svg',
          'icons/icon-192.png',
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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
  preview: { port: DEV_PORT },
  server: {
    port: DEV_PORT,
    proxy: {
      '/v1': { target: API_DEV_ORIGIN, changeOrigin: true, ws: true },
    },
  },
});
