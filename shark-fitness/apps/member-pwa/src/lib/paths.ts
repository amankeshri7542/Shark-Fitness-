/**
 * The member app is served under `/app/` (see vite.config.ts `base`). The
 * router is told about it through `basepath`, but the browser's own
 * `location.pathname` still carries the prefix, so anything that compares
 * paths by hand strips it here first.
 */
export const APP_BASE = '/app';

/** `/app/train` → `/train`; `/app` and `/app/` → `/`. */
export function appPath(pathname: string): string {
  if (pathname === APP_BASE || pathname === `${APP_BASE}/`) return '/';
  return pathname.startsWith(`${APP_BASE}/`) ? pathname.slice(APP_BASE.length) : pathname;
}

/** `/train` → `/app/train`, for links that leave the router (notifications, share). */
export function absoluteAppPath(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return clean === '/' ? `${APP_BASE}/` : `${APP_BASE}${clean}`;
}
