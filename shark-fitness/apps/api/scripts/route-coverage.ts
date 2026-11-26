// Route coverage (P08, PRD 02 §14.1): which registered API routes did the
// integration suite exercise?
//
//   tsx scripts/route-coverage.ts <request-log.ndjson>
//
// The log is written by src/__tests__/helpers/route-recorder.ts during a test
// run with SHARK_ROUTE_COVERAGE_LOG set (`pnpm test:route-coverage` does both).
// Every logged request is resolved through the app's own router, so a request
// counts for exactly the route that served it (the first matching non-ALL
// handler, as Hono dispatches), never for a look-alike pattern.
//
// A route is "covered" when at least one request reached it past the edge:
// not refused as unauthenticated (401), rate-limited (429) or by the CSRF/Origin
// gate. A 403 from the route's own permission check counts, which is how the
// authorization matrix exercises routes. Writes route-coverage.json and exits
// 1 when a route is neither covered nor listed in route-coverage-exceptions.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { app } from '../src/app.js';

interface Logged {
  method: string;
  path: string;
  status: number;
  code?: string;
  message?: string;
}

interface Exception {
  route: string;
  reason: string;
}

const MAX_EXCEPTIONS = 5;
const EDGE_REFUSALS = [/did not come from an allowed Shark Fitness app/, /Refresh the page and try that action again/];

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: tsx scripts/route-coverage.ts <request-log.ndjson>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..');

/** Every registered endpoint, as scripts/postman/list-routes.ts lists them. */
function registeredRoutes(): string[] {
  const seen = new Set<string>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    seen.add(`${route.method} ${route.path}`);
  }
  return [...seen].sort();
}

type RouterRoute = { method: string; path: string };
type MatchEntry = [[unknown, RouterRoute], unknown];

/** The route Hono would dispatch this request to (HEAD is served by GET). */
function routeFor(method: string, path: string): string | null {
  const effective = method === 'HEAD' ? 'GET' : method;
  const [entries] = app.router.match(effective, path) as unknown as [MatchEntry[]];
  for (const [[, route]] of entries) {
    if (route.method !== 'ALL') return `${route.method} ${route.path}`;
  }
  return null;
}

function pastTheEdge(entry: Logged): boolean {
  if (entry.status === 401 || entry.status === 429) return false;
  if (entry.status === 403 && entry.message && EDGE_REFUSALS.some((pattern) => pattern.test(entry.message!))) return false;
  return true;
}

const routes = registeredRoutes();
const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
const hits = new Map<string, { requests: number; exercised: number; succeeded: number; statuses: Set<number> }>();
let unmatched = 0;
for (const line of lines) {
  const entry = JSON.parse(line) as Logged;
  const route = routeFor(entry.method, entry.path);
  if (!route) {
    unmatched += 1;
    continue;
  }
  const hit = hits.get(route) ?? { requests: 0, exercised: 0, succeeded: 0, statuses: new Set<number>() };
  hit.requests += 1;
  hit.statuses.add(entry.status);
  if (pastTheEdge(entry)) hit.exercised += 1;
  if (entry.status >= 200 && entry.status < 400) hit.succeeded += 1;
  hits.set(route, hit);
}

const exceptions = JSON.parse(readFileSync(resolve(root, 'route-coverage-exceptions.json'), 'utf8')) as Exception[];
const problems: string[] = [];
if (exceptions.length > MAX_EXCEPTIONS) problems.push(`${exceptions.length} exceptions; at most ${MAX_EXCEPTIONS} are allowed.`);
for (const exception of exceptions) {
  if (!exception.reason?.trim()) problems.push(`Exception ${exception.route} has no reason.`);
  if (!routes.includes(exception.route)) problems.push(`Exception ${exception.route} is not a registered route (remove it).`);
}
const excepted = new Set(exceptions.map((exception) => exception.route));

const covered = routes.filter((route) => (hits.get(route)?.exercised ?? 0) > 0);
const uncovered = routes.filter((route) => !covered.includes(route) && !excepted.has(route));
const coveredExceptions = routes.filter((route) => excepted.has(route) && covered.includes(route));
for (const route of coveredExceptions) problems.push(`Exception ${route} is covered now (remove it from the exceptions).`);
const withoutSuccess = covered.filter((route) => (hits.get(route)?.succeeded ?? 0) === 0);

const report = {
  generatedAt: new Date().toISOString(),
  totalRoutes: routes.length,
  coveredRoutes: covered.length,
  exceptionRoutes: excepted.size,
  coveragePercent: Number(((covered.length / routes.length) * 100).toFixed(2)),
  coveragePercentExcludingExceptions: Number(((covered.length / (routes.length - excepted.size)) * 100).toFixed(2)),
  requestsLogged: lines.length,
  requestsWithoutRoute: unmatched,
  uncovered,
  exceptions,
  /** Covered, but no request in the suite got a 2xx/3xx (only refusals). */
  coveredWithoutSuccess: withoutSuccess,
  routes: Object.fromEntries(
    routes.map((route) => {
      const hit = hits.get(route);
      return [
        route,
        hit
          ? { requests: hit.requests, exercised: hit.exercised, succeeded: hit.succeeded, statuses: [...hit.statuses].sort((a, b) => a - b) }
          : { requests: 0, exercised: 0, succeeded: 0, statuses: [] },
      ];
    }),
  ),
};
writeFileSync(resolve(root, 'route-coverage.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `Route coverage: ${covered.length}/${routes.length} routes exercised (${report.coveragePercent} %), ${excepted.size} documented exceptions, ${lines.length} requests logged.`,
);
if (withoutSuccess.length > 0) console.log(`${withoutSuccess.length} covered routes were only ever refused (see coveredWithoutSuccess).`);
if (uncovered.length > 0) {
  console.error(`\n${uncovered.length} routes no integration test exercises:`);
  for (const route of uncovered) console.error(`  ${route}`);
}
for (const problem of problems) console.error(problem);
process.exit(uncovered.length > 0 || problems.length > 0 ? 1 : 0);
