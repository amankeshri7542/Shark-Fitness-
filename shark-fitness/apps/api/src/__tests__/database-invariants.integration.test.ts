import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, schema, sqlite } from '../db/client.js';
import { id } from '../lib/ids.js';
import { now } from '../lib/time.js';

describe('database append-only invariants', () => {
  it('refuses both updates and deletes of stock ledger history', () => {
    const product = db.select().from(schema.retailProducts).limit(1).get()!;
    const rowId = id('stk');

    sqlite.exec('BEGIN');
    try {
      db.insert(schema.stockLedger)
        .values({
          id: rowId,
          tenantId: product.tenantId,
          branchId: 'br_kor',
          productId: product.id,
          delta: 0,
          reason: 'invariant_probe',
          refType: null,
          refId: null,
          actorName: 'Test',
          note: null,
          unitCostMinor: null,
          negativeOverride: false,
          overrideReason: null,
          at: now(),
        })
        .run();

      expect(() => db.update(schema.stockLedger).set({ note: 'rewritten' }).where(eq(schema.stockLedger.id, rowId)).run()).toThrow(
        /stock_ledger is append-only/,
      );
      expect(() => db.delete(schema.stockLedger).where(eq(schema.stockLedger.id, rowId)).run()).toThrow(
        /stock_ledger is append-only/,
      );
    } finally {
      sqlite.exec('ROLLBACK');
    }
  });

  it('installs indexes for durable delivery identity and bounded operational pruning', () => {
    const names = new Set(
      (sqlite.prepare("select name from sqlite_master where type = 'index'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    for (const name of [
      'automation_deliveries_retention_idx',
      'automation_runs_delivery_uq',
      'automation_runs_retention_idx',
      'idempotency_created_idx',
      'job_runs_retention_idx',
      'otp_consumed_idx',
      'otp_expiry_idx',
      'outbox_retention_idx',
      'outbox_seq_uq',
      'sessions_expiry_idx',
      'sessions_revoked_idx',
      'used_windows_used_at_idx',
    ]) {
      expect(names.has(name), `missing database index ${name}`).toBe(true);
    }
  });
});
