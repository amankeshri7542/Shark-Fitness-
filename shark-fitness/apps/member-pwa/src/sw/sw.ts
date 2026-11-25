/// <reference lib="webworker" />
/**
 * The member app's service worker (scope /app/). Built by vite-plugin-pwa's
 * injectManifest strategy; see vite.config.ts.
 *
 * What it does, and deliberately does not do:
 * - Precaches the app shell (HTML, JS, CSS, fonts, a few icons) so the app
 *   opens with no network. The member's data comes from the persisted query
 *   cache in IndexedDB, not from here.
 * - Answers navigations with the precached shell; if even that is missing it
 *   serves offline.html.
 * - Never touches /v1: API calls always go to the network. The outbox owns
 *   offline writes and the query cache owns offline reads.
 * - Waits to be told before taking over (`registerType: 'prompt'`): the page
 *   decides when an update is safe (never during a workout).
 * - Shows push notifications and opens their exact deep link on tap.
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute, setCatchHandler } from 'workbox-routing';
import { deepLinkUrl, parsePushPayload } from '../lib/push-payload';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

const SHELL = '/app/index.html';
const OFFLINE = '/app/offline.html';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(new NavigationRoute(createHandlerBoundToURL(SHELL)));

setCatchHandler(async ({ request }) => {
  if (request.destination === 'document') {
    return (await matchPrecache(OFFLINE)) ?? Response.error();
  }
  return Response.error();
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // First install: control the page that registered us without a reload, so
  // the very first visit already works offline afterwards. On an update the
  // page asked for this (SKIP_WAITING) and reloads on controllerchange.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event: PushEvent) => {
  // parsePushPayload accepts the raw text: a payload that is not JSON still
  // shows a generic notification rather than failing silently.
  const payload = parsePushPayload(event.data?.text() ?? null);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/app/icons/icon-192.png',
      badge: '/app/icons/monochrome-96.png',
      data: { path: payload.path },
      ...(payload.tag ? { tag: payload.tag } : {}),
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const target = deepLinkUrl((event.notification.data as { path?: unknown } | null)?.path, self.location.origin);
  event.waitUntil(openDeepLink(target));
});

async function openDeepLink(target: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const exact = windows.find((client) => client.url === target);
  if (exact) {
    await exact.focus();
    return;
  }
  // Reuse an open app window rather than stacking a second copy of the app.
  const app = windows.find((client) => new URL(client.url).pathname.startsWith('/app/'));
  if (app) {
    try {
      const navigated = await app.navigate(target);
      await (navigated ?? app).focus();
      return;
    } catch {
      // Not controlled by this worker (yet): fall through to a new window.
    }
  }
  await self.clients.openWindow(target);
}
