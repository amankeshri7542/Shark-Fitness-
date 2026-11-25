import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeConfig } from '../lib/config.js';
import * as schema from './schema/index.js';

/**
 * SQLite stands in for Cloudflare D1 here — same SQL dialect, same migrations,
 * same query shapes, so the repository layer ports without rewriting. See
 * docs/ADR-001-runtime.md for why this deviates from the PRD's D1 binding.
 */

const DB_PATH = runtimeConfig.databasePath;

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

/**
 * Refuses to continue while a write transaction is open on this connection.
 *
 * Called before every outbound provider request. SQLite has one writer, and a
 * transaction that waits on a payment provider holds that lock for as long as
 * the provider takes — every booking, check-in and payment in the gym waits
 * behind it. The pattern instead is: commit an intent, call out, record the
 * outcome in a second transaction.
 */
export function assertNoOpenTransaction(what: string): void {
  if (sqlite.inTransaction) {
    throw new Error(`${what} was attempted inside a database transaction. Commit first, then call the provider.`);
  }
}
