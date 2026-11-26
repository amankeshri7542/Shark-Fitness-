// `pnpm e2e -- --grep @payments` reaches this package with the `--` still in
// front, and Playwright then ignores the flags after it. Drop that one `--`.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const result = spawnSync('playwright', ['test', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
