import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

/**
 * No test may reach a real host (P07: "a network guard proves no real provider
 * host is contacted"). Loaded by vitest before every API test file.
 *
 * `fetch`, `http.request`/`get` and `https.request`/`get` refuse any host that
 * is not loopback, and every refusal is recorded so a test can assert that
 * nothing even tried. Provider drivers take their base URL as a parameter,
 * which is how the channel tests point them at local fake servers.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const blockedRequests: string[] = [];

function hostOf(target: unknown): string | null {
  if (typeof target === 'string' || target instanceof URL) {
    try {
      return new URL(String(target)).hostname;
    } catch {
      return null;
    }
  }
  if (target && typeof target === 'object') {
    const options = target as { hostname?: string | null; host?: string | null; url?: string };
    if (typeof options.url === 'string') return hostOf(options.url);
    return (options.hostname ?? options.host ?? 'localhost')?.replace(/:\d+$/, '') ?? null;
  }
  return null;
}

function refuse(host: string | null, what: string): Error {
  const label = `${what} ${host ?? '(unknown host)'}`;
  blockedRequests.push(label);
  return new Error(`Network guard: tests may not contact ${label}. Point the driver at a local fake.`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input instanceof Request ? input.url : input);
  if (!host || !LOOPBACK.has(host)) throw refuse(host, 'fetch');
  return realFetch(input, init);
}) as typeof fetch;

for (const [mod, name] of [
  [http, 'http'],
  [https, 'https'],
] as const) {
  const realRequest = mod.request.bind(mod) as (...args: unknown[]) => http.ClientRequest;
  const realGet = mod.get.bind(mod) as (...args: unknown[]) => http.ClientRequest;
  const guard = (real: (...args: unknown[]) => http.ClientRequest) =>
    ((...args: unknown[]) => {
      const host = hostOf(args[0]);
      if (!host || !LOOPBACK.has(host)) throw refuse(host, `${name}.request`);
      return real(...args);
    }) as typeof http.request;
  (mod as { request: typeof http.request }).request = guard(realRequest);
  (mod as { get: typeof http.get }).get = guard(realGet);
}
syncBuiltinESMExports();
