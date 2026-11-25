import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { API_ROOT } from './paths';

/**
 * Direct writes to the run's temporary database, for set-up a browser cannot
 * do in a test's time budget (making a session's last password check five
 * minutes old). Never used to assert product behaviour.
 */
type Statement = { run: (...params: unknown[]) => unknown };
type Database = { prepare: (sql: string) => Statement; close: () => void };
const open = createRequire(resolve(API_ROOT, 'package.json'))('better-sqlite3') as new (path: string) => Database;

export function ageReauthentication(email: string, minutes = 6): void {
  const db = new open(process.env.SHARK_E2E_DATABASE!);
  try {
    db.prepare(
      `update sessions set reauthenticated_at = ? where revoked_at is null and user_id in (select id from users where email = ?)`,
    ).run(Date.now() - minutes * 60_000, email);
  } finally {
    db.close();
  }
}
