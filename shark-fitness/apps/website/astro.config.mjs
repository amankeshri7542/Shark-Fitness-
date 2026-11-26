import { defineConfig } from 'astro/config';

/**
 * The public website: static HTML, served by the API process at `/` in
 * production (apps/api/src/lib/static-sites.ts) and by `astro dev` on :5175
 * with `/v1` proxied to the API in development. See docs/WEBSITE.md.
 */
const SITE_URL = (process.env.SITE_URL || 'https://www.sharkfitness.example').replace(/\/$/, '');
const API_TARGET = process.env.SHARK_API_URL || 'http://localhost:8787';

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
    // Every page's CSS is small; inlining it removes the only render-blocking
    // request on a page that otherwise needs nothing before first paint.
    inlineStylesheets: 'always',
  },
  compressHTML: true,
  devToolbar: { enabled: false },
  server: { port: 5175 },
  vite: {
    server: {
      proxy: { '/v1': { target: API_TARGET, changeOrigin: true } },
    },
  },
});
