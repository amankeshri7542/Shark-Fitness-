import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Shark Fitness',
        short_name: 'Shark',
        description: 'Your membership, your training, your gym.',
        theme_color: '#04080b',
        background_color: '#04080b',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The app shell is cached so a workout screen opens with no network.
        // API responses are never cached here — the outbox owns offline writes
        // and stale reads during a workout would be worse than none.
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: 'CacheFirst',
            options: { cacheName: 'fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: /^@shark\/contracts$/, replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)) },
      { find: /^@shark\/domain$/, replacement: fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) },
      { find: /^@shark\/design-tokens$/, replacement: fileURLToPath(new URL('../../packages/design-tokens/src/index.ts', import.meta.url)) },
    ],
    // Exact-match only. A plain string alias also rewrites subpath imports, so
    // `@shark/design-tokens/sonar.css` would resolve inside index.ts. Subpaths
    // resolve through the workspace link and the package's own exports map.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
    },
  },
});
