import type Database from 'better-sqlite3';

/** All application tables, ordered child-first for a deterministic reseed. */
export const SEED_WIPE_TABLES = [
  'media_progress', 'media_assets', 'live_sessions', 'usage_meters',
  'ticket_events', 'interventions', 'feedback',
  'messages', 'conversations', 'tickets',
  'reactions', 'comments', 'content_reports', 'blocks', 'posts',
  'challenge_invitations', 'challenge_participants', 'challenges', 'referrals', 'member_achievements', 'achievements',
  'streaks', 'xp_ledger',
  'weekly_check_ins', 'nutrition_targets', 'daily_metrics', 'habit_logs', 'habits',
  'progress_photos', 'assessments', 'goals', 'measurements',
  'adaptive_decisions', 'personal_records', 'workout_sets', 'workouts',
  'assignment_overrides', 'assignments', 'program_items', 'program_days', 'programs', 'exercises',
  'facility_tasks', 'work_orders', 'equipment',
  'pos_payments', 'pos_order_lines', 'pos_orders',
  'stock_transfer_lines', 'stock_transfers',
  'stock_ledger', 'retail_products', 'retail_product_groups', 'suppliers',
  'appointments', 'waitlist_entries', 'bookings', 'class_sessions', 'class_series', 'rooms', 'class_types',
  'used_access_windows', 'check_ins', 'access_tokens',
  'dunning_attempts', 'provider_events', 'refunds', 'payments', 'invoice_lines', 'invoices',
  'commission_lines', 'commission_rates', 'staff_unavailability', 'shifts', 'staff', 'lead_activities', 'leads',
  'credits', 'membership_events', 'memberships', 'products',
  'member_branches', 'members',
  'automation_runs', 'automation_deliveries', 'metric_rollups', 'automations', 'message_templates', 'notifications',
  'privacy_artifacts', 'privacy_requests', 'legal_holds',
  'job_runs', 'idempotency_keys', 'outbox_events', 'audit_log', 'consents', 'otp_challenges', 'sessions', 'users',
  'branches', 'tenants',
] as const;

interface StoredTrigger {
  name: string;
  tableName: string;
  sql: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Clear demo data without weakening append-only guarantees after the reset.
 *
 * SQLite has no per-session "disable trigger" switch. The audit, XP, ticket,
 * and stock ledgers therefore have to have their application-owned triggers
 * removed for the destructive wipe and restored from sqlite_master in the
 * same schema transaction. A failed delete rolls the trigger drops back too;
 * swallowing that failure would leave a reseed that looked successful while
 * retaining orphaned history.
 */
export function wipeSeedTables(
  connection: Database.Database,
  tables: readonly string[] = SEED_WIPE_TABLES,
): void {
  const tableSet = new Set(tables);
  const triggers = (
    connection
      .prepare("select name, tbl_name as tableName, sql from sqlite_master where type = 'trigger' and sql is not null")
      .all() as StoredTrigger[]
  ).filter((trigger) => tableSet.has(trigger.tableName));
  const foreignKeysWereEnabled = Number(connection.pragma('foreign_keys', { simple: true })) === 1;

  connection.pragma('foreign_keys = OFF');
  try {
    connection.transaction(() => {
      for (const trigger of triggers) connection.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
      for (const table of tables) connection.exec(`DELETE FROM ${quoteIdentifier(table)}`);
      for (const trigger of triggers) connection.exec(trigger.sql);
    })();
  } finally {
    connection.pragma(`foreign_keys = ${foreignKeysWereEnabled ? 'ON' : 'OFF'}`);
  }
}
