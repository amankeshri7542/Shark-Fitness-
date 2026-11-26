// `pnpm -F @shark/e2e audit`: the whole UI/UX and accessibility audit (P10).
//   1. token contrast table (no browser);
//   2. the Playwright audit specs against the production build;
//   3. the generated summaries in docs/ux-audit/.
// Extra arguments go to Playwright, e.g. `pnpm -F @shark/e2e audit -- --grep console`
// (then only the matching specs refresh their data; the summaries are rebuilt
// from whatever data is on disk). See audit/README.md.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

function step(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: resolve(here, '..') });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

step(process.execPath, [resolve(here, 'contrast.mjs')]);
step('playwright', ['test', '--config', resolve(here, 'playwright.audit.config.ts'), ...args]);
step(process.execPath, [resolve(here, 'report.mjs')]);
