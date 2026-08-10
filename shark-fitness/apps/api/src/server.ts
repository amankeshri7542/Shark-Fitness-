import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { app } from './app.js';
import { attachRealtime } from './realtime/hub.js';
import { startScheduler } from './jobs/scheduler.js';

if (process.env.SHARK_SERVE_STATIC === 'true') {
  const memberDist = resolve(import.meta.dirname, '../../member-pwa/dist');
  const adminDist = resolve(import.meta.dirname, '../../admin-web/dist');
  const release = process.env.RENDER_GIT_COMMIT ?? process.env.GITHUB_SHA ?? 'local';

  // @hono/node-server 1.13.x does not support absolute serveStatic roots.
  // Resolve from this module for correctness, then convert back to a path
  // relative to the process working directory used by pnpm/Render.
  const staticRoot = (absolutePath: string): string =>
    (relative(process.cwd(), absolutePath) || '.').replaceAll('\\', '/');
  const memberRoot = staticRoot(memberDist);
  const adminRoot = staticRoot(adminDist);

  const noStore = (c: Parameters<Parameters<typeof app.use>[1]>[0]): void => {
    c.header('Cache-Control', 'no-store, max-age=0, must-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    c.header('X-Shark-Release', release);
  };
  const immutable = (c: Parameters<Parameters<typeof app.use>[1]>[0]): void => {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('X-Shark-Release', release);
  };

  // Admin and member are independent builds on one origin. HTML must always be
  // revalidated so it never points at an asset hash from an older deployment;
  // content-hashed assets themselves are safe to cache forever.
  app.use('/admin/*', async (c, next) => {
    if (c.req.path.startsWith('/admin/assets/')) immutable(c);
    else noStore(c);
    await next();
  });
  app.use('/assets/*', async (c, next) => {
    immutable(c);
    await next();
  });
  for (const path of ['/', '/sw.js', '/registerSW.js', '/manifest.webmanifest'] as const) {
    app.use(path, async (c, next) => {
      noStore(c);
      await next();
    });
  }

  app.get('/admin', (c) => {
    noStore(c);
    return c.redirect('/admin/');
  });
  app.use(
    '/admin/*',
    serveStatic({
      root: adminRoot,
      rewriteRequestPath: (path) => path.replace(/^\/admin/, '') || '/',
    }),
  );
  // A missing hashed asset is an asset failure, not an SPA navigation. Returning
  // index.html here creates the misleading text/html-for-JS/CSS failure mode.
  app.get('/admin/assets/*', (c) => c.notFound());
  app.get('/admin/*', async (c) => {
    noStore(c);
    return c.html(await readFile(resolve(adminDist, 'index.html'), 'utf8'));
  });

  app.use('/*', serveStatic({ root: memberRoot }));
  app.get('/assets/*', (c) => c.notFound());
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/v1/')) return c.notFound();
    noStore(c);
    return c.html(await readFile(resolve(memberDist, 'index.html'), 'utf8'));
  });
}

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[api] listening on 0.0.0.0:${info.port}`);
});

attachRealtime(server as unknown as import('node:http').Server);
startScheduler();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[api] ${signal} — shutting down`);
    server.close(() => process.exit(0));
  });
}
