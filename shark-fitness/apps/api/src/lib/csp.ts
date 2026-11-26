import { createHash } from 'node:crypto';
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
 * What `/` serves: the public website (P03). The member app lives at `/app/`
 * (P03/P04) and the console at `/admin/`.
 */
export const ROOT_SURFACE: Surface = 'website';

/* ——— Inline sources, allowed by hash ————————————————————————————————
   A few inline sources are deliberate: the member app's theme boot script
   (P04: paints the right theme before the bundle loads), the website's theme
   and legacy-link scripts and its inlined CSS (P03), and the offline pages'
   styles. Instead of `'unsafe-inline'`, each is allowed by its SHA-256,
   computed from the built HTML when the static sites are mounted
   (lib/static-sites.ts). A changed or injected inline source has another hash
   and is refused. `style="…"` attributes are not allowed at all (that would
   need `'unsafe-hashes'`); the website keeps its styles in classes. */

export interface InlineSources {
  scripts: string[];
  styles: string[];
}

const inlineSources = new Map<Surface, InlineSources>();

/** Registers a surface's inline-source hashes (null clears; tests). */
export function setInlineSources(surface: Surface, sources: InlineSources | null): void {
  if (sources) inlineSources.set(surface, sources);
  else inlineSources.delete(surface);
}

const hashOf = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** Hashes of every inline script (not JSON data blocks) and `<style>` element
 *  in these HTML documents, de-duplicated and sorted. */
export function inlineSourcesFromHtml(documents: readonly string[]): InlineSources {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  for (const html of documents) {
    for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attributes = match[1] ?? '';
      if (/\ssrc\s*=/i.test(attributes)) continue;
      const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
      // Data blocks (JSON-LD) are never executed, so CSP does not apply.
      if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
      scripts.add(hashOf(match[2] ?? ''));
    }
    for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) styles.add(hashOf(match[1] ?? ''));
  }
  return { scripts: [...scripts].sort(), styles: [...styles].sort() };
}

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
  /** Overrides the registered inline-source hashes (tests). */
  inline?: InlineSources;
}

export function cspFor(surface: Surface, options: CspOptions = {}): string {
  if (surface === 'api') {
    // JSON never needs to load anything. If a response were ever rendered as a
    // document, this makes it inert.
    return ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  }
  const payments = surface === 'member';
  const sockets = surface === 'website' ? [] : socketOrigins(options.origins ?? runtimeConfig.allowedOrigins);
  const inline = options.inline ?? inlineSources.get(surface) ?? { scripts: [], styles: [] };
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...inline.scripts, ...(payments ? PAYMENT_CHECKOUT_SOURCES.script : [])]],
    ['style-src', ["'self'", ...inline.styles]],
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
