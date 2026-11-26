import { describe, expect, it } from 'vitest';
import { creditLots, planConsumption, quotePackRefund, type CreditRow } from '../credits.js';

const T = Date.parse('2026-06-01T10:00:00Z');
const day = 86_400_000;

function grant(id: string, delta: number, expiresOn: string | null, at = T): CreditRow {
  return { id, kind: 'class', delta, lotId: null, expiresOn, createdAt: at, reason: 'Pack' };
}
function row(id: string, lotId: string | null, delta: number, at: number, refType: string | null = 'booking'): CreditRow {
  return { id, kind: 'class', delta, lotId, expiresOn: null, createdAt: at, refType };
}

describe('credit lots', () => {
  it('spends the earliest-expiring lot first, and a never-expiring lot last', () => {
    const balance = creditLots([grant('late', 5, '2026-12-31'), grant('soon', 2, '2026-07-01'), grant('never', 3, null)], '2026-06-10', 'class');
    expect(balance.usable).toBe(10);
    expect(planConsumption(balance, 4)).toEqual([
      { lotId: 'soon', units: 2, expiresOn: '2026-07-01' },
      { lotId: 'late', units: 2, expiresOn: '2026-12-31' },
    ]);
  });

  it('refuses a spend the usable balance cannot cover', () => {
    expect(planConsumption(creditLots([grant('a', 1, null)], '2026-06-10', 'class'), 2)).toBeNull();
  });

  it('an expired lot is not usable, but what it held is still visible', () => {
    const balance = creditLots([grant('old', 4, '2026-06-05'), row('d1', 'old', -1, T + day)], '2026-06-10', 'class');
    expect(balance.lots[0]).toMatchObject({ remaining: 3, used: 1, expired: true, usable: 0 });
    expect(balance.usable).toBe(0);
  });

  it('a restored unit returns to its own lot and keeps that lot’s expiry', () => {
    const rows = [grant('soon', 1, '2026-07-01'), grant('late', 1, '2026-12-31'), row('spend', 'soon', -1, T + day), row('back', 'soon', 1, T + 2 * day)];
    const balance = creditLots(rows, '2026-06-10', 'class');
    expect(balance.lots.find((l) => l.lotId === 'soon')).toMatchObject({ remaining: 1, used: 0, expiresOn: '2026-07-01' });
    // and the next spend takes it first again
    expect(planConsumption(balance, 1)).toEqual([{ lotId: 'soon', units: 1, expiresOn: '2026-07-01' }]);
  });

  it('applies legacy spends without a lot to lots usable on that day, and reports any shortfall', () => {
    const rows = [grant('a', 2, '2026-06-03'), grant('b', 2, '2026-08-01'), row('legacy1', null, -3, T + day, 'booking'), row('legacy2', null, -2, T + 10 * day, 'booking')];
    const balance = creditLots(rows, '2026-06-20', 'class');
    // legacy1 on 06-02: a (2) then b (1). legacy2 on 06-11: a expired, b has 1 → 1 unallocated.
    expect(balance.lots.find((l) => l.lotId === 'a')?.remaining).toBe(0);
    expect(balance.lots.find((l) => l.lotId === 'b')?.remaining).toBe(0);
    expect(balance.unallocatedDebit).toBe(1);
    expect(balance.usable).toBe(0);
  });

  it('counts a refund revocation as revoked, not used', () => {
    const balance = creditLots([grant('p', 10, '2026-12-01'), row('use', 'p', -3, T + day), row('rev', 'p', -7, T + 2 * day, 'refund')], '2026-06-10', 'class');
    expect(balance.lots[0]).toMatchObject({ remaining: 0, used: 3, revoked: 7 });
  });
});

describe('pack refund matrix (decision 11)', () => {
  const lotOf = (rows: CreditRow[], today = '2026-06-10') => creditLots(rows, today, 'class').lots[0]!;

  it('unused → the full amount paid', () => {
    const quote = quotePackRefund({ lot: lotOf([grant('p', 10, '2026-12-01')]), packUnits: 10, paidMinor: 599_900, alreadyRefundedMinor: 0 });
    expect(quote).toMatchObject({ refundable: true, kind: 'full', units: 10, amountMinor: 599_900 });
  });

  it('partially used → unused × unit price, with a reason', () => {
    const quote = quotePackRefund({ lot: lotOf([grant('p', 10, '2026-12-01'), row('u', 'p', -3, T + day)]), packUnits: 10, paidMinor: 599_900, alreadyRefundedMinor: 0 });
    expect(quote).toMatchObject({ refundable: true, kind: 'partial', units: 7, unitPriceMinor: 59_990, amountMinor: 419_930, reasonRequired: true });
  });

  it('expired → refused', () => {
    const quote = quotePackRefund({ lot: lotOf([grant('p', 10, '2026-06-01')]), packUnits: 10, paidMinor: 599_900, alreadyRefundedMinor: 0 });
    expect(quote).toMatchObject({ refundable: false, amountMinor: 0 });
    expect(quote.message).toContain('Expired credits are not refundable');
  });

  it('fully used → refused; unpaid (no lot) → refused', () => {
    expect(quotePackRefund({ lot: lotOf([grant('p', 1, null), row('u', 'p', -1, T + day)]), packUnits: 1, paidMinor: 1000, alreadyRefundedMinor: 0 }).refundable).toBe(false);
    expect(quotePackRefund({ lot: null, packUnits: 1, paidMinor: 0, alreadyRefundedMinor: 0 }).refundable).toBe(false);
  });
});
