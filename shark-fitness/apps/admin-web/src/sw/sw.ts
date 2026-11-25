/// <reference lib="webworker" />
/**
 * The staff console's service worker (scope /admin/).
 *
 * It exists to make the console installable on reception tablets and to
 * start fast. It precaches the shell (HTML, JS, CSS, fonts, icons) and
 * nothing else: every API call goes to the network, and every page load asks
 * the network first, because a console showing yesterday's occupancy or a
 * stale member record is worse than one that says it is offline. Without a
 * connection a navigation gets offline.html.
 *
 * Its scope is /admin/, so it never sees the member app (/app/) or the API.
 */
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

const OFFLINE = '/admin/offline.html';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      return (await matchPrecache(OFFLINE)) ?? Response.error();
    }
  }),
);

// Shell only, nothing a desk is in the middle of: take over at once.
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
