import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { MEMBER_MANIFEST } from './manifest.config';

/** Route chunks left out of the precache. Home, Train, Workout, Summary,
 *  Exercise, Book, Profile, Pass, Help and Sign-in stay in: they work offline
 *  from the saved snapshot or local state. */
const ONLINE_ONLY_SCREENS = ['Pack', 'Challenge', 'Library', 'Billing', 'Progress', 'Notifications', 'Messages', 'Conversation', 'Habits'];

/** Ports stay overridable for machines that run several copies at once. */
const DEV_PORT = Number(process.env.SHARK_MEMBER_DEV_PORT ?? 5173);
const API_DEV_ORIGIN = process.env.SHARK_API_DEV_ORIGIN ?? 'http://localhost:8787';

/**
 * Self-hosted fonts are content-hashed by Vite, so index.html cannot name
 * them by hand. Preload the woff2 files the build emitted: they are needed for
 * the first paint of every screen, and `font-display: swap` alone would show
 * the fallback face first on a slow phone.
 */
function preloadFonts(): Plugin {
  return {
    name: 'shark:preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter((file) => file.endsWith('.woff2'));
        return fonts.map((file) => ({
          tag: 'link',
          attrs: { rel: 'preload', href: `/app/${file}`, as: 'font', type: 'font/woff2', crossorigin: '' },
          injectTo: 'head',
        }));
      },
    },
  };
}

export default defineConfig({
  // The member app lives under /app/ (PHASE-PLAN decision 4): the public
  // website owns /, the console owns /admin/.
  base: '/app/',
  plugins: [
    react(),
    tailwind(),
    preloadFonts(),
    VitePWA({
      // Our own worker (src/sw/sw.ts): push handlers and an offline page need
      // more than generateSW offers. The page registers it (lib/sw-update.ts)
      // so it can hold an update back while a workout is running.
      strategies: 'injectManifest',
      srcDir: 'src/sw',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      scope: '/app/',
      manifestFilename: 'manifest.webmanifest',
      includeAssets: [],
      // Manifest and shortcut icons are fetched by the OS when it installs
      // the app; precaching them would only spend the offline budget.
      includeManifestIcons: false,
      manifest: MEMBER_MANIFEST,
      injectManifest: {
        // The shell, fonts and the icons a notification or offline page
        // needs. Store screenshots and large icons are fetched on demand.
        globPatterns: [
          '**/*.{js,css,html,woff2}',
          'favicon.svg',
          'icons/icon-192.png',
          'icons/monochrome-96.png',
        ],
        // Screens whose data is never saved for offline use (it would only
        // show "could not load" without a connection) are cached the first
        // time they are opened instead (see src/sw/sw.ts), which keeps the
        // install-time download inside budget.
        globIgnores: ['**/screenshots/**', ...ONLINE_ONLY_SCREENS.map((name) => `assets/${name}-*.js`)],
        // Budget guard (PHASE-PLAN P04 criterion 11): the precache must stay
        // under 700 KiB. A single file above this would be a mistake anyway.
        maximumFileSizeToCacheInBytes: 250 * 1024,
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
  preview: { port: DEV_PORT },
  server: {
    port: DEV_PORT,
    proxy: {
      '/v1': { target: API_DEV_ORIGIN, changeOrigin: true, ws: true },
    },
  },
});
