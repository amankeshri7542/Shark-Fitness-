/**
 * The push payload contract shared by the API (services/push.ts) and the
 * service worker. It is deliberately tiny: a title, a body and an in-app path.
 * Nothing else about the member travels through the push service.
 *
 * No DOM or worker globals here: this module is compiled into both the page
 * bundle and the service worker.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** In-app route, e.g. `/messages/cnv_123`. Never a full URL. */
  path: string;
  /** Collapses repeats of the same event on the device. */
  tag?: string;
}

export const APP_PREFIX = '/app';
export const FALLBACK_PATH = '/notifications';

/** A path is safe when it is a same-app route: starts with one slash, no
 *  scheme, no protocol-relative `//host`, no backslashes, no control chars. */
export function isSafeAppPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 512 &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(path)
  );
}

/** Reads whatever arrived in a push event. A malformed payload still shows a
 *  generic notification (browsers penalise silent pushes) that opens the inbox. */
export function parsePushPayload(raw: unknown): PushPayload {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = null;
    }
  }
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.slice(0, 120) : 'Shark Fitness';
  const body = typeof record.body === 'string' ? record.body.slice(0, 240) : 'You have a new notification.';
  const path = isSafeAppPath(record.path) ? record.path : FALLBACK_PATH;
  const tag = typeof record.tag === 'string' && record.tag ? record.tag.slice(0, 64) : undefined;
  return tag ? { title, body, path, tag } : { title, body, path };
}

/** The absolute URL a notification click opens: always inside `/app/` on
 *  this origin, whatever the payload claimed. */
export function deepLinkUrl(path: unknown, origin: string): string {
  const safe = isSafeAppPath(path) ? path : FALLBACK_PATH;
  const prefixed = safe === APP_PREFIX || safe.startsWith(`${APP_PREFIX}/`) ? safe : `${APP_PREFIX}${safe}`;
  const url = new URL(prefixed, origin);
  return url.origin === new URL(origin).origin ? url.href : new URL(`${APP_PREFIX}${FALLBACK_PATH}`, origin).href;
}
