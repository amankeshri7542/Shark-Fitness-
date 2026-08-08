import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema/index.js';

/**
 * SQLite stands in for Cloudflare D1 here — same SQL dialect, same migrations,
 * same query shapes, so the repository layer ports without rewriting. See
 * docs/ADR-001-runtime.md for why this deviates from the PRD's D1 binding.
 */

const DB_PATH = process.env.SHARK_DB ?? resolve(process.cwd(), 'data/shark.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const sqlite: Database.Database = new Database(DB_PATH);

// WAL keeps readers unblocked while the booking transaction holds its write.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
// The last-seat claim needs a write lock rather than an immediate SQLITE_BUSY.
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;
export { schema };

/**
 * Runs `fn` inside a single write transaction. This is the only concurrency
 * authority for capacity changes and waitlist promotion (PF-SCH-003) — nothing
 * else may adjust `class_sessions.booked`.
 */
export function transact<T>(fn: () => T): T {
  return sqlite.transaction(fn)();
}
