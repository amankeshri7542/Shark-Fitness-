import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { app } from './app.js';
import { attachRealtime } from './realtime/hub.js';
import { startScheduler } from './jobs/scheduler.js';

if (process.env.SHARK_SERVE_STATIC === 'true') {
  const memberDist = resolve(import.meta.dirname, '../../member-pwa/dist');
  const adminDist = resolve(import.meta.dirname, '../../admin-web/dist');

  app.get('/admin', (c) => c.redirect('/admin/'));
  app.use(
    '/admin/*',
    serveStatic({
      root: adminDist,
      rewriteRequestPath: (path) => path.replace(/^\/admin/, '') || '/',
    }),
  );
  app.get('/admin/*', async (c) => c.html(await readFile(resolve(adminDist, 'index.html'), 'utf8')));

  app.use('/*', serveStatic({ root: memberDist }));
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/v1/')) return c.notFound();
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
