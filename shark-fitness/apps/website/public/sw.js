/*
 * Retires the member app's old service worker.
 *
 * Until the member app moved to /app/, it installed a worker at /sw.js with
 * scope "/". That worker would keep answering "/" with the old app shell.
 * Browsers re-check a registered worker's script on navigation, so serving
 * this file at the same URL replaces it: it activates at once, deletes the
 * caches the old worker owned (never /app/'s), unregisters itself and reloads
 * open pages so they come from the network. The website never registers it.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const scope = self.registration.scope;
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.endsWith(scope) || name === 'fonts').map((name) => caches.delete(name)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) client.navigate(client.url);
    })(),
  );
});
