import { and, asc, eq, gt } from 'drizzle-orm';
import { channels } from '@shark/contracts';
import { creditLots, planConsumption, type CreditBalance, type CreditRow } from '@shark/domain';
import { db, schema } from '../db/client.js';
import { audit } from '../lib/audit.js';
import type { RequestContext } from '../lib/context.js';
import { entitlementMissing } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';

/**
 * The credit ledger (decision 11). Append-only (triggers in `db/migrate.ts`):
 * every change to a member's credits is a new row, and every non-grant row
 * names the lot it draws on or returns to. The arithmetic is `creditLots` in
 * `@shark/domain`; this module only reads rows and writes new ones, always
 * inside the caller's transaction.
 */

export type CreditKind = 'class' | 'pt';

export function ledgerRows(memberId: string): CreditRow[] {
  return db
    .select({
      id: schema.credits.id,
      kind: schema.credits.kind,
      delta: schema.credits.delta,
      lotId: schema.credits.lotId,
      expiresOn: schema.credits.expiresOn,
      createdAt: schema.credits.createdAt,
      reason: schema.credits.reason,
      refType: schema.credits.refType,
      packId: schema.credits.packId,
    })
    .from(schema.credits)
    .where(eq(schema.credits.memberId, memberId))
    .orderBy(asc(schema.credits.createdAt), asc(schema.credits.id))
    .all();
}

export function creditBalance(memberId: string, kind: CreditKind, today: string): CreditBalance {
  return creditLots(ledgerRows(memberId), today, kind);
}

/** Spends `units` earliest-expiry first, one row per lot drawn on. Throws when
 *  the usable balance cannot cover it (eligibility should have said so first). */
export function spendCredits(
  tenantId: string,
  memberId: string,
  kind: CreditKind,
  units: number,
  ref: { reason: string; refType: string; refId: string },
  today: string,
  atMs: number,
): Array<{ lotId: string; units: number }> {
  if (units <= 0) return [];
  const plan = planConsumption(creditBalance(memberId, kind, today), units);
  if (!plan) {
    throw entitlementMissing(kind === 'pt' ? 'There are no personal training credits left to use.' : 'There are no class credits left to use.');
  }
  for (const part of plan) {
    db.insert(schema.credits)
      .values({
        id: id('crd'),
        tenantId,
        memberId,
        kind,
        delta: -part.units,
        reason: ref.reason,
        refType: ref.refType,
        refId: ref.refId,
        expiresOn: part.expiresOn,
        createdAt: atMs,
        lotId: part.lotId,
        packId: null,
      })
      .run();
  }
  return plan;
}

/**
 * Gives back what a booking (or session) spent, each unit to the lot it came
 * from, so it keeps that lot's original expiry. A unit returned to a lot that
 * has since expired is returned expired: the member is never handed time they
 * did not buy. Idempotent per ref: a second call restores nothing.
 */
export function restoreSpend(
  tenantId: string,
  memberId: string,
  ref: { refType: string; refId: string },
  reason: string,
  atMs: number,
): number {
  const rows = db
    .select()
    .from(schema.credits)
    .where(and(eq(schema.credits.memberId, memberId), eq(schema.credits.refType, ref.refType), eq(schema.credits.refId, ref.refId)))
    .all();
  const net = rows.reduce((sum, row) => sum + row.delta, 0);
  if (net >= 0) return 0;

  // Net spend per lot (legacy rows without a lot come back as their own lot).
  const perLot = new Map<string | null, { units: number; expiresOn: string | null; kind: string }>();
  for (const row of rows) {
    const key = row.lotId;
    const entry = perLot.get(key) ?? { units: 0, expiresOn: row.expiresOn, kind: row.kind };
    entry.units += -row.delta;
    perLot.set(key, entry);
  }
  let restored = 0;
  for (const [lotId, entry] of perLot) {
    if (entry.units <= 0) continue;
    db.insert(schema.credits)
      .values({
        id: id('crd'),
        tenantId,
        memberId,
        kind: entry.kind,
        delta: entry.units,
        reason,
        refType: ref.refType,
        refId: ref.refId,
        expiresOn: entry.expiresOn,
        createdAt: atMs,
        lotId,
        packId: null,
      })
      .run();
    restored += entry.units;
  }
  return restored;
}

/**
 * Credits for a pack exist only once its invoice is paid in full — called by
 * `settleInvoicePayment` in the same transaction as the payment that completes
 * the invoice (staff-recorded or provider-confirmed alike). Idempotent.
 */
export function allocatePackForInvoice(
  ctx: RequestContext,
  invoice: { id: string; tenantId: string; memberId: string; refType: string | null; refId: string | null },
  atMs: number,
): boolean {
  if (invoice.refType !== 'credit_pack' || !invoice.refId) return false;
  const pack = db
    .select()
    .from(schema.creditPacks)
    .where(and(eq(schema.creditPacks.id, invoice.refId), eq(schema.creditPacks.tenantId, invoice.tenantId), eq(schema.creditPacks.invoiceId, invoice.id)))
    .get();
  if (!pack || pack.state !== 'pending_payment') return false;

  const today = isoDate(atMs, branchTimeZone(pack.tenantId, pack.branchId));
  const expiresOn = addDays(today, pack.validDays);
  const lotId = id('crd');
  db.insert(schema.credits)
    .values({
      id: lotId,
      tenantId: pack.tenantId,
      memberId: pack.memberId,
      kind: pack.creditKind,
      delta: pack.units,
      reason: `Purchased ${pack.productName}`,
      refType: 'credit_pack',
      refId: pack.id,
      expiresOn,
      createdAt: atMs,
      lotId: null,
      packId: pack.id,
    })
    .run();
  db.update(schema.creditPacks)
    .set({ state: 'active', allocatedAt: atMs, expiresOn, updatedAt: atMs })
    .where(and(eq(schema.creditPacks.id, pack.id), eq(schema.creditPacks.state, 'pending_payment')))
    .run();

  audit(ctx, {
    action: 'credit_pack.allocated',
    entityType: 'credit_pack',
    entityId: pack.id,
    entityLabel: pack.productName,
    branchId: pack.branchId,
    after: { units: pack.units, kind: pack.creditKind, expiresOn, invoiceId: invoice.id },
  });
  emit({
    tenantId: pack.tenantId,
    branchId: pack.branchId,
    channel: channels.member(pack.memberId),
    topic: 'invoice.updated',
    payload: { invoiceId: invoice.id, creditPackId: pack.id, creditsAllocated: pack.units },
  });
  return true;
}

/** The grant row (lot) of a pack, if it has been allocated. */
export function packLot(packId: string) {
  return db
    .select()
    .from(schema.credits)
    .where(and(eq(schema.credits.packId, packId), eq(schema.credits.refType, 'credit_pack'), gt(schema.credits.delta, 0)))
    .get();
}

/** Takes the unused units of a lot back for a refund. */
export function revokeLotForRefund(
  pack: { id: string; tenantId: string; memberId: string; creditKind: string },
  lot: { id: string; expiresOn: string | null },
  units: number,
  refundId: string,
  reason: string,
  atMs: number,
): void {
  db.insert(schema.credits)
    .values({
      id: id('crd'),
      tenantId: pack.tenantId,
      memberId: pack.memberId,
      kind: pack.creditKind,
      delta: -units,
      reason: `Refund: ${reason}`,
      refType: 'refund',
      refId: refundId,
      expiresOn: lot.expiresOn,
      createdAt: atMs,
      lotId: lot.id,
      packId: pack.id,
    })
    .run();
}

/**
 * A provider refund that failed gives the credits back: the money never left,
 * so the member keeps what they paid for. A compensating row, never an edit.
 * Idempotent per refund.
 */
export function reinstateRevokedCredits(ctx: RequestContext, refundId: string, atMs: number): number {
  const revoked = db
    .select()
    .from(schema.credits)
    .where(and(eq(schema.credits.refType, 'refund'), eq(schema.credits.refId, refundId)))
    .all();
  if (revoked.length === 0) return 0;
  const already = db
    .select()
    .from(schema.credits)
    .where(and(eq(schema.credits.refType, 'refund_reversal'), eq(schema.credits.refId, refundId)))
    .get();
  if (already) return 0;

  let units = 0;
  for (const row of revoked) {
    db.insert(schema.credits)
      .values({
        id: id('crd'),
        tenantId: row.tenantId,
        memberId: row.memberId,
        kind: row.kind,
        delta: -row.delta,
        reason: 'Refund did not go through, credits returned',
        refType: 'refund_reversal',
        refId: refundId,
        expiresOn: row.expiresOn,
        createdAt: atMs,
        lotId: row.lotId,
        packId: row.packId,
      })
      .run();
    units += -row.delta;
    if (row.packId) {
      const pack = db.select().from(schema.creditPacks).where(eq(schema.creditPacks.id, row.packId)).get();
      if (pack && (pack.state === 'refunded' || pack.state === 'partially_refunded')) {
        db.update(schema.creditPacks).set({ state: 'active', updatedAt: atMs }).where(eq(schema.creditPacks.id, pack.id)).run();
      }
    }
  }
  audit(ctx, { action: 'credit_pack.refund_reversed', entityType: 'refund', entityId: refundId, after: { unitsReturned: units } });
  return units;
}
