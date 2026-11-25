/**
 * The member PWA owns a root-scoped service worker because it must support
 * offline member routes. Admin is a separate SPA on the same origin. Ask an
 * older root worker to update before the console settles, and reload once if
 * a newly activated worker takes control, so existing demo browsers recover
 * without anyone clearing site data by hand.
 *
 * This used to be an inline <script> in index.html. It moved into the bundle
 * so the console's Content-Security-Policy can be `script-src 'self'` with no
 * inline allowance (docs/SECURITY.md).
 */
export function recoverFromRootServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  const reloadKey = 'shark.admin.sw-recovered';
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem(reloadKey)) return;
    sessionStorage.setItem(reloadKey, '1');
    location.reload();
  });
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) =>
      Promise.all(
        registrations
          .filter((registration) => {
            const scope = new URL(registration.scope);
            return scope.origin === location.origin && scope.pathname === '/';
          })
          .map((registration) => registration.update().catch(() => undefined)),
      ),
    )
    .catch(() => undefined);
}
