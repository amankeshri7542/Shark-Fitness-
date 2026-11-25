import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, Hono } from 'hono';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

/**
 * The three front ends on one origin (single-origin hosting, PRD 05 §5):
 *
 *   /         the public website   (apps/website/dist, static Astro output)
 *   /app/     the member app       (apps/member-pwa/dist, SPA + service worker)
 *   /admin/   the staff console    (apps/admin-web/dist, SPA)
 *
 * Caching: content-hashed assets (`/_astro/`, `/app/assets/`, `/admin/assets/`)
 * are immutable for a year; everything else — HTML, service workers,
 * manifests, robots, sitemap — is revalidated on every request, so a deploy
 * is never hidden behind a stale shell that points at assets that no longer
 * exist. A missing hashed asset is a 404, never an HTML page served as
 * JavaScript.
 *
 * The member app used to live at `/`. Its old deep links (`/sign-in#…`
 * activation links, `/book`, home-screen bookmarks) are redirected to `/app/…`
 * with the query kept; browsers carry the `#fragment` across a redirect.
 */
export interface StaticSiteRoots {
  websiteDist: string;
  memberDist: string;
  adminDist: string;
  release: string;
}

/** First path segments the member app used when it was served from `/`. */
export const LEGACY_MEMBER_PATHS = [
  'sign-in',
  'train',
  'progress',
  'pack',
  'book',
  'habits',
  'messages',
  'billing',
  'library',
  'profile',
  'notifications',
  'pass',
  'workout',
] as const;

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function mountStaticSites(app: Hono, roots: StaticSiteRoots): void {
  // @hono/node-server 1.13.x does not support absolute serveStatic roots.
  // Resolve absolutely for correctness, then hand it a path relative to the
  // process working directory used by pnpm/Render/Docker.
  const relativeRoot = (absolutePath: string): string => (relative(process.cwd(), absolutePath) || '.').replaceAll('\\', '/');
  const website = relativeRoot(roots.websiteDist);
  const member = relativeRoot(roots.memberDist);
  const admin = relativeRoot(roots.adminDist);

  const revalidate = (c: Context): void => {
    c.header('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    c.header('X-Shark-Release', roots.release);
  };
  const noStore = (c: Context): void => {
    c.header('Cache-Control', 'no-store, max-age=0, must-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    c.header('X-Shark-Release', roots.release);
  };
  const immutable = (c: Context): void => {
    c.header('Cache-Control', IMMUTABLE);
    c.header('X-Shark-Release', roots.release);
  };
  const isHashedAsset = (path: string): boolean =>
    path.startsWith('/_astro/') || path.startsWith('/app/assets/') || path.startsWith('/admin/assets/');

  // Headers first, for every static response. Set before `next()` so a 404
  // for a missing asset still carries them; never applied to the API.
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path.startsWith('/v1/') || path === '/health' || path === '/ready' || path === '/metrics') {
      await next();
      return;
    }
    const hashed = isHashedAsset(path);
    if (hashed) immutable(c);
    else if (path.startsWith('/app/') || path.startsWith('/admin/')) noStore(c);
    else revalidate(c);
    await next();
    // Only a file that exists is immutable. A cached 404 for a hashed name
    // would outlive the deploy that ships it.
    if (hashed && c.res.status !== 200) c.header('Cache-Control', 'no-store');
  });

  /* — Staff console ———————————————————————————————————————————— */
  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use('/admin/*', serveStatic({ root: admin, rewriteRequestPath: (path) => path.replace(/^\/admin/, '') || '/' }));
  app.get('/admin/assets/*', (c) => c.notFound());
  app.get('/admin/*', async (c) => c.html(await readFile(resolve(roots.adminDist, 'index.html'), 'utf8')));

  /* — Member app —————————————————————————————————————————————— */
  app.get('/app', (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`/app/${url.search}`);
  });
  app.use('/app/*', serveStatic({ root: member, rewriteRequestPath: (path) => path.replace(/^\/app/, '') || '/' }));
  app.get('/app/assets/*', (c) => c.notFound());
  app.get('/app/*', async (c) => {
    // A missing file (an old workbox chunk, a stale icon) is a 404, not the
    // shell: only extension-less paths are app routes.
    if (/\.[a-z0-9]+$/i.test(c.req.path)) return c.notFound();
    return c.html(await readFile(resolve(roots.memberDist, 'index.html'), 'utf8'));
  });

  // Old member deep links, from when the app was served at `/`.
  for (const segment of LEGACY_MEMBER_PATHS) {
    const forward = (c: Context) => {
      const url = new URL(c.req.url);
      noStore(c);
      return c.redirect(`/app${url.pathname}${url.search}`, 302);
    };
    app.get(`/${segment}`, forward);
    app.get(`/${segment}/*`, forward);
  }

  /* — Public website ————————————————————————————————————————————— */
  // Precompressed .br/.gz siblings are written by the website build.
  app.use('/*', serveStatic({ root: website, precompressed: true }));
  app.get('/_astro/*', (c) => c.notFound());
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/v1/')) return c.notFound();
    const notFoundPage = resolve(roots.websiteDist, '404.html');
    if (!existsSync(notFoundPage)) return c.notFound();
    return c.html(await readFile(notFoundPage, 'utf8'), 404);
  });
}
