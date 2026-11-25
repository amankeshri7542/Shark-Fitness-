import type { Context, Hono } from 'hono';

/**
 * PLACEHOLDER for the public website (phase P03), which owns `/`.
 *
 * Until the website is served here, `/` forwards to the member app. A 302
 * keeps the URL fragment, so an activation or recovery link written as
 * `/#activationId=…` still lands on the right form at `/app/#activationId=…`.
 *
 * `/sw.js` retires the member service worker that older releases registered at
 * scope `/`. Browsers re-check a registered worker's script on navigation; a
 * byte-different script installs, and this one deletes the old root caches,
 * unregisters itself and reloads its pages so they reach the network (and the
 * `/app/`-scoped worker) instead of a stale shell. The website build ships the
 * same retirement worker, so this file goes away when P03 is integrated.
 */
export const RETIRE_ROOT_WORKER_SOURCE = `/* Shark Fitness: retires the member worker that used to live at scope "/". */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const rootScope = self.registration.scope;
    const names = await caches.keys();
    // Only caches the old root worker owned. The /app/ worker's precache name
    // carries its own scope and must survive.
    await Promise.all(names.filter((name) => name.endsWith(rootScope) || name === 'fonts').map((name) => caches.delete(name)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => undefined)));
  })());
});
`;

export function mountRootPlaceholder(app: Hono, noStore: (c: Context) => void): void {
  app.get('/', (c) => {
    noStore(c);
    return c.redirect('/app/', 302);
  });
  app.get('/sw.js', (c) => {
    noStore(c);
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(RETIRE_ROOT_WORKER_SOURCE);
  });
}
