import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

/* ============================================================================
   Outbound HTTP to addresses a customer typed in (webhook endpoints), with
   SSRF defences (PRD 04 ENT-SEC-002, OWASP SSRF prevention):

   - https only in production; http and loopback only outside production,
     where the tests run a receiver on 127.0.0.1;
   - the host is resolved once, *every* address is checked against private,
     loopback, link-local, metadata, multicast and reserved ranges, and the
     connection is made to an address that passed — a DNS answer that changes
     between check and connect (rebinding) never reaches a private address;
   - no redirects (a 3xx is a failed delivery, not a hop), a 5-second budget,
     and at most 64 KB of the answer is read.
   ========================================================================= */

export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['169.254.0.0', 16], // link-local, including 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, and deprecated IPv4-compatible (::10.0.0.1); ::1 is judged as loopback first
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT)
  ['64:ff9b:1::', 48], // local-use NAT64, which a private network may translate to its own IPv4
  ['100::', 64], // discard
  ['2002::', 16], // 6to4, which embeds an IPv4 address
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local, including fd00:ec2::254 metadata
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

export interface SafeHttpPolicy {
  /** Production: https only, no loopback. */
  production: boolean;
}

export class UnsafeDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDestinationError';
  }
}

/** An IPv4 address hidden inside IPv6 (::ffff:10.0.0.1, 64:ff9b::a00:1) is judged as IPv4. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1]!;
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return null;
}

/** Why an address may not be contacted, or null when it may. */
export function addressRefusal(address: string, policy: SafeHttpPolicy): string | null {
  const v4 = isIP(address) === 6 ? embeddedIpv4(address) : null;
  const candidate = v4 ?? address;
  const family = isIP(candidate) === 4 ? 'ipv4' : 'ipv6';
  if (isIP(candidate) === 0) return 'not an IP address';
  if (loopback.check(candidate, family)) return policy.production ? 'a loopback address' : null;
  if (blocked.check(candidate, family)) return 'a private, link-local or reserved address';
  return null;
}

/** Static checks on the URL itself, at save time and again before each send. */
export function urlRefusal(raw: string, policy: SafeHttpPolicy): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a valid URL.';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !policy.production)) return 'Use an https:// address.';
  if (url.username || url.password) return 'Remove the username and password from the address.';
  if (!url.hostname) return 'The address needs a host name.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const refusal = addressRefusal(host, policy);
    if (refusal) return `That address points at ${refusal}, which webhooks may not reach.`;
  } else if (policy.production && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) {
    return 'That host name is internal; webhooks may not reach it.';
  }
  return null;
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
  });

export interface SafePostResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  /** First KB of the body, for the delivery log. */
  responseExcerpt: string | null;
  error: string | null;
}

/**
 * POSTs `body` to `url` under the policy. Never throws: every outcome,
 * including a refused destination, is a result the caller records.
 */
export async function safePost(
  url: string,
  body: string,
  headers: Record<string, string>,
  policy: SafeHttpPolicy,
  resolver: Resolver = systemResolver,
): Promise<SafePostResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const refusedUrl = urlRefusal(url, policy);
  if (refusedUrl) return { ok: false, statusCode: null, latencyMs: elapsed(), responseExcerpt: null, error: refusedUrl };

  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  let address: LookupAddress;
  try {
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await withTimeout(resolver(host), REQUEST_TIMEOUT_MS);
    if (addresses.length === 0) throw new Error('no addresses');
    for (const candidate of addresses) {
      const refusal = addressRefusal(candidate.address, policy);
      if (refusal) throw new UnsafeDestinationError(`${target.hostname} resolves to ${refusal}; not contacted.`);
    }
    address = addresses[0]!;
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: elapsed(),
      responseExcerpt: null,
      error: error instanceof UnsafeDestinationError ? error.message : `Could not resolve ${target.hostname}.`,
    };
  }

  return new Promise<SafePostResult>((resolve) => {
    let settled = false;
    const finish = (result: Omit<SafePostResult, 'latencyMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, latencyMs: elapsed() });
    };
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: target.protocol,
        // Connect to the address that was checked; keep the name for TLS (SNI
        // and certificate verification) and for the Host header.
        host: address.address,
        family: address.family,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        servername: isIP(host) ? undefined : host,
        headers: { ...headers, host: target.host, 'content-length': Buffer.byteLength(body).toString() },
        // A webhook never follows a redirect and never reuses a socket.
        agent: false,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return;
          const room = MAX_RESPONSE_BYTES - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (size >= MAX_RESPONSE_BYTES) res.destroy();
        });
        const done = () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const excerpt = text ? text.slice(0, 1024) : null;
          if (status >= 300 && status < 400) {
            finish({ ok: false, statusCode: status, responseExcerpt: excerpt, error: 'The receiver answered with a redirect, which webhooks do not follow.' });
          } else {
            finish({ ok: status >= 200 && status < 300, statusCode: status, responseExcerpt: excerpt, error: status >= 200 && status < 300 ? null : `The receiver answered ${status}.` });
          }
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, statusCode: null, responseExcerpt: null, error: `No answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.` });
    }, REQUEST_TIMEOUT_MS);
    req.on('error', (error) => finish({ ok: false, statusCode: null, responseExcerpt: null, error: `Connection failed: ${(error as NodeJS.ErrnoException).code ?? error.message}` }));
    req.end(body);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
