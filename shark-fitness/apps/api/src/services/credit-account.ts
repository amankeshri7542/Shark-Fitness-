import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { branchTimeZone } from '../lib/branch-time.js';
import { isoDate, now } from '../lib/time.js';
import { classCreditsHeld } from './booking.js';
import type { CreditAccount } from '@shark/contracts';

/** Read the existing ledger faithfully; new allocation/return policy is not yet approved. */
export function readCreditAccount(member: typeof schema.members.$inferSelect): CreditAccount {
  const today = isoDate(now(), branchTimeZone(member.tenantId, member.homeBranchId));
  const entries = db.select().from(schema.credits).where(and(eq(schema.credits.tenantId, member.tenantId), eq(schema.credits.memberId, member.id))).orderBy(desc(schema.credits.createdAt), desc(schema.credits.id)).all();
  const balances = (['class', 'pt'] as const).map((kind) => {
    const rows = entries.filter((row) => row.kind === kind);
    // Keep class display identical to the booking engine, including its legacy
    // signed shortfall. Do not silently manufacture a correction or new grant.
    const signedBalance = kind === 'class' ? classCreditsHeld(member.id, today) : rows.reduce((sum, row) => sum + (row.expiresOn !== null && row.expiresOn < today ? 0 : row.delta), 0);
    return { kind, signedBalance, usableUnits: kind === 'class' ? Math.max(0, signedBalance) : null,
      ledgerUnits: rows.reduce((sum, row) => sum + row.delta, 0),
      consumptionAvailable: kind === 'class',
      warning: signedBalance < 0 ? 'The credit record has a negative balance after expiry. No adjustment was made; owner reconciliation is required.' : null };
  });
  return {
    today, balances,
    entries: entries.map((row) => ({ id: row.id, kind: row.kind, delta: row.delta, reason: row.reason, refType: row.refType, refId: row.refId,
      expiresOn: row.expiresOn, expired: row.expiresOn !== null && row.expiresOn < today, createdAt: new Date(row.createdAt).toISOString() })),
    saleAvailable: false as const,
    saleUnavailableReason: 'New credit sales await approval of which pack to use first, how cancelled bookings return credits after expiry, and how refunds affect credits. PT credit use is unavailable.',
    historyNotice: 'Earlier credit grants may not contain their original purchased terms. The recorded expiry dates are shown below; no credit history has been changed.',
  };
}
