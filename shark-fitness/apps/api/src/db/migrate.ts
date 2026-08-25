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

  // One occurrence per series per branch-local date. This is what makes series
  // generation idempotent: a second generator run, or two of them at once,
  // loses at the index rather than producing a second Tuesday. Partial,
  // because legacy sessions carry a free-text `series_id` and no
  // `occurrence_date`, and NULLs must not collide with each other.
  `CREATE UNIQUE INDEX IF NOT EXISTS class_sessions_series_occurrence_uq
     ON class_sessions (series_id, occurrence_date)
     WHERE series_id IS NOT NULL AND occurrence_date IS NOT NULL`,

  // One commission accrual per source transaction per member of staff. The
  // partial clause is what lets a correction exist: a compensating entry
  // carries `correction_of_line_id` and is therefore outside the index, so a
  // reversal can cite the same sale without colliding with it.
  `CREATE UNIQUE INDEX IF NOT EXISTS commission_lines_source_uq
     ON commission_lines (tenant_id, staff_id, kind, ref_type, ref_id)
     WHERE correction_of_line_id IS NULL AND ref_id IS NOT NULL`,

  // One send per automation per logical event, enforced by the database rather
  // than by the service remembering to check (PF-COMM-004). Partial, so a
  // failed run leaves the key free to retry and a dry run never consumes it.
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_sent_uq
     ON automation_runs (automation_id, event_key)
     WHERE outcome = 'sent'`,

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

  `CREATE TRIGGER IF NOT EXISTS stock_ledger_no_delete
     BEFORE DELETE ON stock_ledger
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
