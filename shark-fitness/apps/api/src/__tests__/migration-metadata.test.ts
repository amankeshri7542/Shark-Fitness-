import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * drizzle-kit diffs the schema files listed in drizzle.config.ts against the
 * newest snapshot in infrastructure/migrations/meta. A schema file missing from
 * that list, or a snapshot chain that stops short of the journal, makes the
 * next `drizzle-kit generate` emit a wrong migration (dropping or re-creating
 * tables). `pnpm -F @shark/api db:check-drift` proves the full diff is empty;
 * these checks explain *why* when it is not.
 */
const apiRoot = resolve(import.meta.dirname, '../..');
const migrations = resolve(apiRoot, '../../infrastructure/migrations');

interface Snapshot {
  id: string;
  prevId: string;
}

describe('migration metadata', () => {
  it('lists every schema file the barrel exports in drizzle.config.ts', () => {
    const barrel = readFileSync(resolve(apiRoot, 'src/db/schema/index.ts'), 'utf8');
    const exported = [...barrel.matchAll(/export \* from '\.\/([\w-]+)\.js';/g)].map((match) => `./src/db/schema/${match[1]}.ts`);
    const config = readFileSync(resolve(apiRoot, 'drizzle.config.ts'), 'utf8');
    const listed = [...config.matchAll(/'(\.\/src\/db\/schema\/[\w-]+\.ts)'/g)].map((match) => match[1]);

    expect(exported.length).toBeGreaterThanOrEqual(8);
    expect([...listed].sort()).toEqual([...exported].sort());
  });

  it('has one snapshot per journal entry, chained in order', () => {
    const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    let previous: Snapshot | null = null;
    for (const entry of journal.entries) {
      const number = String(entry.idx).padStart(4, '0');
      expect(entry.tag.startsWith(number)).toBe(true);
      const snapshot = JSON.parse(readFileSync(resolve(migrations, `meta/${number}_snapshot.json`), 'utf8')) as Snapshot;
      if (previous) expect(snapshot.prevId, `${number} must follow the previous snapshot`).toBe(previous.id);
      previous = snapshot;
    }
  });
});
