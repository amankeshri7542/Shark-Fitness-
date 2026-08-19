import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { db, sqlite } from './client.js';

const folder = resolve(process.cwd(), '../../infrastructure/migrations');

migrate(db, { migrationsFolder: folder });

/**
 * Constraints Drizzle's builder cannot express. Applied after the generated
 * migrations, idempotently.
 */
const extras = [
  // One live booking per member per session. Cancelled rows must not block a
  // rebooking, so the uniqueness is partial (PF-SCH: two members, last seat).
  `CREATE UNIQUE INDEX IF NOT EXISTS bookings_live_uq
     ON bookings (session_id, member_id)
     WHERE state IN ('held', 'confirmed', 'attended')`,

  // A session can never be booked past its capacity, even if a service layer
  // bug tries. The database is the last line, not the first.
  `CREATE TRIGGER IF NOT EXISTS class_sessions_capacity_guard
     BEFORE UPDATE OF booked ON class_sessions
     WHEN NEW.booked > NEW.capacity
     BEGIN SELECT RAISE(ABORT, 'CAPACITY_EXHAUSTED'); END`,

  `CREATE TRIGGER IF NOT EXISTS class_sessions_capacity_guard_neg
     BEFORE UPDATE OF booked ON class_sessions
     WHEN NEW.booked < 0
     BEGIN SELECT RAISE(ABORT, 'NEGATIVE_BOOKED'); END`,

  // The audit log is append-only. Enforce it where it cannot be argued with.
  `CREATE TRIGGER IF NOT EXISTS audit_log_no_update
     BEFORE UPDATE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,

  `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
     BEFORE DELETE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,

  // Same for the XP ledger — corrections are compensating rows (PF-GAME-002).
  `CREATE TRIGGER IF NOT EXISTS xp_ledger_no_update
     BEFORE UPDATE ON xp_ledger
     BEGIN SELECT RAISE(ABORT, 'xp_ledger is append-only'); END`,

  `CREATE TRIGGER IF NOT EXISTS xp_ledger_no_delete
     BEFORE DELETE ON xp_ledger
     BEGIN SELECT RAISE(ABORT, 'xp_ledger is append-only'); END`,

  // And the stock ledger — stock on hand is a sum, never a stored counter.
  `CREATE TRIGGER IF NOT EXISTS stock_ledger_no_update
     BEFORE UPDATE ON stock_ledger
     BEGIN SELECT RAISE(ABORT, 'stock_ledger is append-only'); END`,

  // And the ticket timeline — PF-SUP-006 asks for immutable records for
  // disputes and safety incidents, and a record that can be edited by whoever
  // is being disputed with is not one. A correction is a new event.
  `CREATE TRIGGER IF NOT EXISTS ticket_events_no_update
     BEFORE UPDATE ON ticket_events
     BEGIN SELECT RAISE(ABORT, 'ticket_events is append-only'); END`,

  `CREATE TRIGGER IF NOT EXISTS ticket_events_no_delete
     BEFORE DELETE ON ticket_events
     BEGIN SELECT RAISE(ABORT, 'ticket_events is append-only'); END`,

  `CREATE INDEX IF NOT EXISTS outbox_undelivered_idx
     ON outbox_events (delivered_at, seq) WHERE delivered_at IS NULL`,
];

for (const sql of extras) {
  sqlite.exec(sql);
}

console.log('migrations applied');
sqlite.close();
