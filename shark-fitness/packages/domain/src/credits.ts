/**
 * Credit lots (decision 11). Pure arithmetic over the append-only ledger.
 *
 * Every grant row is a lot with its own expiry. Every other row cites the lot
 * it draws on or returns to (`lotId`): a booking spends from a lot, a timely
 * cancellation gives the unit back *to the same lot* (so it keeps the lot's
 * original expiry), a refund revokes what is left of a lot. Nothing is ever
 * updated or deleted, so the balance at any moment is a replay.
 *
 * Rows written before lots existed carry no `lotId`. Legacy spends are applied
 * to the lots that were usable when they happened, earliest expiry first; a
 * legacy spend no lot can absorb is reported as `unallocatedDebit` rather than
 * quietly forgiven.
 */

export interface CreditRow {
  id: string;
  kind: string;
  delta: number;
  lotId: string | null;
  expiresOn: string | null;
  createdAt: number;
  reason?: string;
  refType?: string | null;
  packId?: string | null;
}

export interface CreditLot {
  lotId: string;
  kind: string;
  granted: number;
  /** Units still in the lot, before expiry is considered. */
  remaining: number;
  /** Units spent from the lot net of restorations. */
  used: number;
  /** Units taken back by a refund or correction. */
  revoked: number;
  expiresOn: string | null;
  expired: boolean;
  /** What a member can spend today: remaining, unless the lot has expired. */
  usable: number;
  createdAt: number;
  packId: string | null;
  reason: string;
}

export interface CreditBalance {
  lots: CreditLot[];
  usable: number;
  /** Legacy spends that no lot could cover. Shown, never hidden. */
  unallocatedDebit: number;
}

/** Earliest expiry first; a lot that never expires goes last; ties by age. */
function byExpiry(a: { expiresOn: string | null; createdAt: number }, b: { expiresOn: string | null; createdAt: number }): number {
  if (a.expiresOn !== b.expiresOn) {
    if (a.expiresOn === null) return 1;
    if (b.expiresOn === null) return -1;
    return a.expiresOn < b.expiresOn ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function creditLots(rows: CreditRow[], today: string, kind: string): CreditBalance {
  const mine = rows.filter((row) => row.kind === kind);
  const lots = new Map<string, CreditLot>();

  for (const row of mine) {
    if (row.lotId === null && row.delta > 0) {
      lots.set(row.id, {
        lotId: row.id,
        kind,
        granted: row.delta,
        remaining: row.delta,
        used: 0,
        revoked: 0,
        expiresOn: row.expiresOn,
        expired: false,
        usable: 0,
        createdAt: row.createdAt,
        packId: row.packId ?? null,
        reason: row.reason ?? '',
      });
    }
  }

  let unallocatedDebit = 0;
  const ordered = [...mine].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const row of ordered) {
    if (row.lotId !== null) {
      const lot = lots.get(row.lotId);
      if (!lot) {
        if (row.delta < 0) unallocatedDebit += -row.delta;
        continue;
      }
      lot.remaining += row.delta;
      if (row.refType === 'refund') lot.revoked += -row.delta;
      else if (row.refType === 'refund_reversal') lot.revoked -= row.delta;
      else lot.used -= row.delta;
      continue;
    }
    if (row.delta >= 0) continue; // a grant, handled above
    // A legacy spend without a lot: draw on lots usable on the day it happened.
    let owed = -row.delta;
    const day = dayOf(row.createdAt);
    const candidates = [...lots.values()]
      .filter((lot) => lot.createdAt <= row.createdAt && lot.remaining > 0 && (lot.expiresOn === null || lot.expiresOn >= day))
      .sort(byExpiry);
    for (const lot of candidates) {
      if (owed === 0) break;
      const take = Math.min(owed, lot.remaining);
      lot.remaining -= take;
      lot.used += take;
      owed -= take;
    }
    unallocatedDebit += owed;
  }

  const out = [...lots.values()].sort(byExpiry);
  for (const lot of out) {
    lot.expired = lot.expiresOn !== null && lot.expiresOn < today;
    lot.usable = lot.expired ? 0 : Math.max(0, lot.remaining);
  }
  return { lots: out, usable: Math.max(0, out.reduce((sum, lot) => sum + lot.usable, 0) - unallocatedDebit), unallocatedDebit };
}

/**
 * Which lots pay for `units`, earliest expiry first. `null` when the usable
 * balance cannot cover it.
 */
export function planConsumption(balance: CreditBalance, units: number): Array<{ lotId: string; units: number; expiresOn: string | null }> | null {
  if (units <= 0) return [];
  if (balance.usable < units) return null;
  const plan: Array<{ lotId: string; units: number; expiresOn: string | null }> = [];
  let owed = units;
  for (const lot of balance.lots) {
    if (owed === 0) break;
    if (lot.usable <= 0) continue;
    const take = Math.min(owed, lot.usable);
    plan.push({ lotId: lot.lotId, units: take, expiresOn: lot.expiresOn });
    owed -= take;
  }
  return owed === 0 ? plan : null;
}

export type PackRefundQuote =
  | { refundable: true; kind: 'full' | 'partial'; units: number; amountMinor: number; unitPriceMinor: number; reasonRequired: boolean; message: string }
  | { refundable: false; units: 0; amountMinor: 0; message: string };

/**
 * Decision 11's refund matrix for one pack:
 * - wholly unused and unexpired → everything paid, all credits revoked;
 * - partly used → unused units × unit price (price ÷ units, rounded down), a
 *   reason required;
 * - expired → refused (expired credits are not refundable);
 * - nothing left → refused.
 */
export function quotePackRefund(input: { lot: CreditLot | null; packUnits: number; paidMinor: number; alreadyRefundedMinor: number }): PackRefundQuote {
  const { lot, packUnits, paidMinor, alreadyRefundedMinor } = input;
  if (!lot) return { refundable: false, units: 0, amountMinor: 0, message: 'This pack has no credits yet, so there is nothing to refund. Void the unpaid invoice instead.' };
  if (lot.expired) return { refundable: false, units: 0, amountMinor: 0, message: 'These credits have expired. Expired credits are not refundable.' };
  const unused = Math.max(0, lot.remaining);
  if (unused === 0) return { refundable: false, units: 0, amountMinor: 0, message: 'Every credit in this pack has been used or refunded. There is nothing left to refund.' };
  const unitPriceMinor = Math.floor(paidMinor / packUnits);
  const outstanding = Math.max(0, paidMinor - alreadyRefundedMinor);
  if (unused === packUnits && lot.revoked === 0) {
    return { refundable: true, kind: 'full', units: unused, amountMinor: outstanding, unitPriceMinor, reasonRequired: true,
      message: `None of the ${packUnits} credits were used, so the full amount paid comes back and all credits are removed.` };
  }
  const amountMinor = Math.min(outstanding, unused * unitPriceMinor);
  return { refundable: true, kind: 'partial', units: unused, amountMinor, unitPriceMinor, reasonRequired: true,
    message: `${packUnits - unused} of ${packUnits} credits are used or gone. The ${unused} unused ${unused === 1 ? 'credit is' : 'credits are'} refunded at the pack's unit price and removed.` };
}
