import type { MiddlewareHandler } from 'hono';
import { app } from '../../app.js';

/**
 * The API's route table, read from Hono itself, for the tests that enumerate
 * every route (security-route-enumeration, strict-body-schemas). A route added
 * tomorrow is in this list without anybody remembering to add it to a test.
 */
export interface RouteInfo {
  method: string;
  path: string;
}

export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Every `METHOD /path` the app answers, once each (middleware entries excluded). */
export function listRoutes(): RouteInfo[] {
  const seen = new Set<string>();
  const routes: RouteInfo[] = [];
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path: route.path });
  }
  return routes;
}

/** The route path with every `:param` replaced by `value(name)`. */
export function concretePath(path: string, value: (param: string, index: number) => string): string {
  let index = 0;
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => encodeURIComponent(value(name, index++)));
}

export function paramsOf(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
}

interface RouterLike {
  match(method: string, path: string): [Array<[[MiddlewareHandler, { path: string; method: string }], unknown]>, unknown];
}

/**
 * Every handler that runs for `METHOD path`, in order: global middleware, the
 * mount's middleware, then the route's own handlers. Reads Hono's router, so
 * it is exactly the chain a real request would get. Only the handlers
 * registered for this route's own pattern are kept from the final group, so a
 * second router mounted on the same path (a shadowed handler) is not counted
 * as protecting this one.
 */
export function chainFor(route: RouteInfo): MiddlewareHandler[] {
  const router = (app as unknown as { router: RouterLike }).router;
  const concrete = concretePath(route.path, () => 'route-probe');
  const [matches] = router.match(route.method, concrete);
  const chain: MiddlewareHandler[] = [];
  for (const [[handler, meta]] of matches) {
    if (meta.method === 'ALL' || (meta.method === route.method && meta.path === route.path)) chain.push(handler);
  }
  return chain;
}
