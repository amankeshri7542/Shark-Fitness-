#!/usr/bin/env node
// Fails when the Drizzle schema has changes no migration records.
//
// Runs `drizzle-kit generate` against a scratch database. If it writes
// anything into infrastructure/migrations, someone changed a schema file
// without generating its migration (or the snapshots drifted from the SQL), so
// the files it wrote are removed again and the check fails.
//
//   pnpm -F @shark/api db:check-drift
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const apiRoot = resolve(import.meta.dirname, '..');
const migrations = resolve(apiRoot, '../../infrastructure/migrations');
const journal = join(migrations, 'meta/_journal.json');

const listing = () => [
  ...readdirSync(migrations).map((name) => name),
  ...readdirSync(join(migrations, 'meta')).map((name) => `meta/${name}`),
];
const before = new Set(listing());
const journalBefore = readFileSync(journal, 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'shark-drift-'));

let output = '';
try {
  output = execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate', '--name', 'drift_check'], {
    cwd: apiRoot,
    env: { ...process.env, SHARK_DB: join(scratch, 'drift.db') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const written = listing().filter((name) => !before.has(name));
const journalChanged = readFileSync(journal, 'utf8') !== journalBefore;
if (written.length === 0 && !journalChanged) {
  console.log('migration_drift=none (drizzle-kit generate: no schema changes)');
  process.exit(0);
}

for (const name of written) {
  if (name.endsWith('.sql')) console.error(`--- ${name} ---\n${readFileSync(join(migrations, name), 'utf8')}`);
  rmSync(join(migrations, name), { force: true });
}
writeFileSync(journal, journalBefore);
console.error(output.split('\n').slice(-5).join('\n'));
console.error(
  'migration_drift=FOUND: the schema files differ from the latest migration snapshot.\n' +
    'Run `pnpm -F @shark/api exec drizzle-kit generate --name <change>` and commit the SQL and snapshot it writes.',
);
process.exit(1);
