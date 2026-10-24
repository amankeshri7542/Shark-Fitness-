// Prints every route the API serves, one "METHOD /path" per line, for
// generate.mjs. Run through tsx so it reads the routes from source.
import { app } from '../../apps/api/src/app.js';

const seen = new Set<string>();
for (const route of app.routes) {
  if (route.method === 'ALL') continue;
  const key = `${route.method} ${route.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(key);
}
