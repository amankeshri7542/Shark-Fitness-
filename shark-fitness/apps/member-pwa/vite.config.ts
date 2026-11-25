import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

/**
 * The member app lives at /app/ on the single origin: the public website owns
 * / (apps/website) and the staff console /admin/. Base path, router basepath,
 * manifest scope and service-worker scope all follow from this one value.
 */
export const MEMBER_BASE = '/app/';

export default defineConfig({
  base: MEMBER_BASE,
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
        // Under /app/: an install made from the website's origin must open the
        // app, never the marketing site, and must not claim /admin/.
        id: MEMBER_BASE,
        scope: MEMBER_BASE,
        start_url: MEMBER_BASE,
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The app shell is cached so a workout screen opens with no network.
        // API responses are never cached here — the outbox owns offline writes
        // and stale reads during a workout would be worse than none.
        // The worker is scoped to /app/ (it is served from there), so it can
        // only ever see member navigations. The fallback is the precached
        // shell at /app/index.html; the allow-list restates the scope, and the
        // deny-list stays as a second guard should the scope ever widen: the
        // website at /, the console at /admin/, the API and health checks must
        // never be answered with the member shell.
        navigateFallback: `${MEMBER_BASE}index.html`,
        navigateFallbackAllowlist: [/^\/app(?:\/|$)/],
        navigateFallbackDenylist: [/^\/admin(?:\/|$)/, /^\/v1(?:\/|$)/, /^\/health\/?$/],
        cleanupOutdatedCaches: true,
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
