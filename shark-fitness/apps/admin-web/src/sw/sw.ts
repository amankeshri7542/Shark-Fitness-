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
// No directory index (an empty name): a request for /admin/ is never answered from the
// precache, it goes to the network (or the offline page) like every page.
precacheAndRoute(self.__WB_MANIFEST, { directoryIndex: '' });

registerRoute(
  new NavigationRoute(async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      return (await matchPrecache(OFFLINE)) ?? Response.error();
    }
  }),
);

// Shell only: a new build installs straight away. It does not claim open
// pages; the next navigation picks it up, so nobody's screen reloads under them.
self.addEventListener('install', () => void self.skipWaiting());
