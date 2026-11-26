import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { runtimeConfig } from '../lib/config.js';

/**
 * Web Push transport (RFC 8030 + RFC 8291 encryption + RFC 8292 VAPID).
 *
 * `web-push` builds the encrypted body and the VAPID headers; the request
 * itself goes out through `fetch` with a timeout, so a slow push service can
 * never hold the scheduler, and tests can replace the transport with a local
 * fake push service (and prove nothing else is called).
 *
 * The payload is the one shape the service worker reads
 * (apps/member-pwa/src/lib/push-payload.ts): title, body, in-app path and a
 * collapse tag. Nothing else about the member goes to Google, Apple, Mozilla
 * or Microsoft.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** In-app route, e.g. `/messages/cnv_1`. Never a full URL. */
  path: string;
  tag?: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRequest {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type PushTransport = (request: PushRequest) => Promise<{ status: number }>;

/** sent: accepted by the push service. gone: the subscription no longer
 *  exists (404/410) and must be deleted. retry: try again later (429/5xx,
 *  network). rejected: will never work as sent (bad endpoint, 4xx). */
export type PushOutcome = 'sent' | 'gone' | 'retry' | 'rejected';

/**
 * The browser push services. A subscription whose endpoint is anywhere else
 * is refused: otherwise any member could make the server POST to an address
 * of their choosing (an internal host, for example).
 */
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
] as const;
const PUSH_SERVICE_SUFFIXES = ['.notify.windows.com', '.push.apple.com'] as const;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (runtimeConfig.push.extraEndpointOrigins.includes(url.origin)) return true;
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return (
    (PUSH_SERVICE_HOSTS as readonly string[]).includes(host) || PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

const TIMEOUT_MS = 10_000;

const fetchTransport: PushTransport = async (request) => {
  const response = await fetch(request.endpoint, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status };
};

let transport: PushTransport = fetchTransport;

/** Tests only: route sends to a fake push service. Returns a restore function. */
export function usePushTransport(replacement: PushTransport): () => void {
  const previous = transport;
  transport = replacement;
  return () => {
    transport = previous;
  };
}

export function pushConfigured(): boolean {
  return runtimeConfig.push.vapid !== null;
}

/** The encrypted request for one device, ready to send. */
export function buildPushRequest(
  target: PushTarget,
  message: PushMessage,
  options: { ttlSec: number; urgency: 'very-low' | 'low' | 'normal' | 'high' },
): PushRequest {
  const vapid = runtimeConfig.push.vapid;
  if (!vapid) throw new Error('Web Push is not configured (SHARK_VAPID_*).');
  const details = webpush.generateRequestDetails(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    JSON.stringify(message),
    {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: options.ttlSec,
      urgency: options.urgency,
      contentEncoding: 'aes128gcm',
    },
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(details.headers)) {
    // fetch sets the length itself from the body.
    if (name.toLowerCase() !== 'content-length') headers[name] = String(value);
  }
  return {
    endpoint: details.endpoint,
    method: details.method,
    headers,
    body: new Uint8Array(details.body as Buffer),
  };
}

export async function sendPush(
  target: PushTarget,
  message: PushMessage,
  options: { ttlSec: number; urgency: 'very-low' | 'low' | 'normal' | 'high' },
): Promise<PushOutcome> {
  if (!pushConfigured() || !isAllowedPushEndpoint(target.endpoint)) return 'rejected';
  let request: PushRequest;
  try {
    request = buildPushRequest(target, message, options);
  } catch {
    // Malformed keys stored for this device: it can never be reached.
    return 'gone';
  }
  try {
    const { status } = await transport(request);
    if (status >= 200 && status < 300) return 'sent';
    if (status === 404 || status === 410) return 'gone';
    if (status === 429 || status >= 500) return 'retry';
    return 'rejected';
  } catch {
    return 'retry';
  }
}

/** A fresh VAPID key pair, for `pnpm -F @shark/api vapid:keys`. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
