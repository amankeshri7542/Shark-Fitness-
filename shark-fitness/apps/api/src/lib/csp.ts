import { runtimeConfig } from './config.js';

/* ============================================================================
   Content-Security-Policy, per surface (PRD 04 §10.1, docs/SECURITY.md).

   Every allowed origin lives in this file. A new third party is a reviewed
   change here, not an `'unsafe-*'` keyword or a wildcard somewhere else.

   - `'self'` covers the hashed bundles, the service worker and manifest, the
     self-hosted fonts, and `/v1` on the same origin.
   - No `'unsafe-inline'` anywhere. React sets `style={{…}}` through the CSSOM
     (`element.style`), which CSP does not govern, so `style-src 'self'` holds;
     the end-to-end listener proves it on every page it visits.
   - Payments: Razorpay Standard Checkout, member app only. Razorpay does not
     publish a CSP allowlist; these are the origins its checkout.js loads and
     calls (script from checkout.razorpay.com, the payment iframe from
     api.razorpay.com, telemetry to lumberjack.razorpay.com). The P02
     sandbox E2E must confirm them against the live modal before go-live.
   ========================================================================= */

export type Surface = 'admin' | 'member' | 'website' | 'api';

/** Razorpay Standard Checkout. The only third party any page may talk to. */
export const PAYMENT_CHECKOUT_SOURCES = {
  script: ['https://checkout.razorpay.com'],
  frame: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
  connect: ['https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
} as const;

/**
 * What `/` serves. On this branch it is the member app; when the public
 * website lands at `/` (P03) and the member app moves to `/app/`, this
 * becomes `'website'` — the one line the integration has to change.
 */
export const ROOT_SURFACE: Surface = 'member';

export const CSP_REPORT_PATH = '/v1/csp-reports';

export function surfaceForPath(path: string): Surface {
  if (path === '/v1' || path.startsWith('/v1/') || path === '/health' || path === '/ready' || path === '/metrics') return 'api';
  if (path === '/admin' || path.startsWith('/admin/')) return 'admin';
  if (path === '/app' || path.startsWith('/app/')) return 'member';
  return ROOT_SURFACE;
}

/**
 * The realtime socket, spelled out. CSP Level 3 lets `'self'` match `ws:` and
 * `wss:` on the same host, but older Safari did not; naming the origins costs
 * nothing and keeps the live console working there.
 */
function socketOrigins(origins: readonly string[]): string[] {
  return [...new Set(origins.map((origin) => origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')))];
}

export interface CspOptions {
  origins?: readonly string[];
}

export function cspFor(surface: Surface, options: CspOptions = {}): string {
  if (surface === 'api') {
    // JSON never needs to load anything. If a response were ever rendered as a
    // document, this makes it inert.
    return ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  }
  const payments = surface === 'member';
  const sockets = surface === 'website' ? [] : socketOrigins(options.origins ?? runtimeConfig.allowedOrigins);
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...(payments ? PAYMENT_CHECKOUT_SOURCES.script : [])]],
    ['style-src', ["'self'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...sockets, ...(payments ? PAYMENT_CHECKOUT_SOURCES.connect : [])]],
    ['frame-src', payments ? [...PAYMENT_CHECKOUT_SOURCES.frame] : ["'none'"]],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'self'"]],
    ['report-uri', [CSP_REPORT_PATH]],
    ['report-to', ['csp']],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** The header name: enforcing, unless an operator switched to report-only. */
export function cspHeaderName(reportOnly = runtimeConfig.cspReportOnly): string {
  return reportOnly ? 'content-security-policy-report-only' : 'content-security-policy';
}

/** `camera` is for the console's member-pass scanner only (`/admin/*`). */
export function permissionsPolicyFor(surface: Surface): string {
  return `camera=(${surface === 'admin' ? 'self' : ''}), microphone=(), geolocation=()`;
}
