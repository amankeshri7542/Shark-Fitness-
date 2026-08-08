import { describe, expect, it } from 'vitest';
import {
  applyFreeze,
  canTransition,
  deriveState,
  isEntitled,
  prorate,
} from '../membership.js';

describe('membership state machine', () => {
  it('allows the documented transitions', () => {
    expect(canTransition({ from: 'active', to: 'frozen', reason: 'holiday', actorRole: 'member' }).ok).toBe(true);
    expect(canTransition({ from: 'grace', to: 'active', reason: 'paid', actorRole: 'system' }).ok).toBe(true);
    expect(canTransition({ from: 'pending_payment', to: 'active', reason: 'paid', actorRole: 'provider' }).ok).toBe(true);
  });

  it('refuses an undocumented transition with a reason, not an exception', () => {
    const r = canTransition({ from: 'expired', to: 'active', reason: 'renewal', actorRole: 'staff' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TERMINAL_STATE');
  });

  it('treats rejoining as a new record, never a transition on the old one', () => {
    for (const terminal of ['cancelled', 'expired'] as const) {
      const r = canTransition({ from: terminal, to: 'active', reason: 'rejoin', actorRole: 'staff' });
      expect(r.ok).toBe(false);
    }
  });

  it('requires a reason before suspending or cancelling', () => {
    const r = canTransition({ from: 'active', to: 'suspended', reason: '', actorRole: 'staff' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('REASON_REQUIRED');
  });

  it('lets grace members through the door', () => {
    expect(isEntitled('grace')).toBe(true);
    expect(isEntitled('active')).toBe(true);
    expect(isEntitled('suspended')).toBe(false);
    expect(isEntitled('expired')).toBe(false);
  });
});

describe('freeze', () => {
  const base = {
    endsOn: '2026-09-14',
    daysUsed: 0,
    maxDaysPerTerm: 30,
    minDaysPerFreeze: 7,
    extendsExpiry: true,
    allowed: true,
  };

  it('extends expiry only when the purchased product says so', () => {
    const extending = applyFreeze({ ...base, freezeDays: 14 });
    expect(extending).toEqual({ ok: true, newEndsOn: '2026-09-28', daysUsed: 14 });

    const notExtending = applyFreeze({ ...base, freezeDays: 14, extendsExpiry: false });
    expect(notExtending).toEqual({ ok: true, newEndsOn: '2026-09-14', daysUsed: 14 });
  });

  it('refuses a freeze past the term allowance and says how much is left', () => {
    const r = applyFreeze({ ...base, daysUsed: 25, freezeDays: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('5 freeze days are left');
  });

  it('refuses a freeze shorter than the minimum', () => {
    expect(applyFreeze({ ...base, freezeDays: 3 }).ok).toBe(false);
  });
});

describe('proration', () => {
  it('charges only the difference for the unused remainder on an upgrade', () => {
    // Half a 30-day term left; 2000 → 3000 minor for the term.
    expect(prorate({ currentPriceMinor: 2000, newPriceMinor: 3000, daysRemaining: 15, termDays: 30 }))
      .toEqual({ chargeMinor: 500, creditMinor: 0 });
  });

  it('produces a credit rather than a negative charge on a downgrade', () => {
    expect(prorate({ currentPriceMinor: 3000, newPriceMinor: 2000, daysRemaining: 15, termDays: 30 }))
      .toEqual({ chargeMinor: 0, creditMinor: 500 });
  });
});

describe('derived state', () => {
  it('moves an overdue membership into grace, then to expired', () => {
    const args = { current: 'active' as const, endsOn: '2026-08-01', graceDays: 7, hasOutstandingBalance: true };
    expect(deriveState({ ...args, today: '2026-08-04' })).toBe('grace');
    expect(deriveState({ ...args, today: '2026-08-09' })).toBe('expired');
  });

  it('does not resurrect a frozen or suspended membership by date alone', () => {
    expect(deriveState({ current: 'frozen', endsOn: '2026-08-01', today: '2026-09-01', graceDays: 7, hasOutstandingBalance: false })).toBe('frozen');
    expect(deriveState({ current: 'suspended', endsOn: '2026-08-01', today: '2026-09-01', graceDays: 7, hasOutstandingBalance: false })).toBe('suspended');
  });

  it('returns a grace member to active once the balance clears', () => {
    expect(deriveState({ current: 'grace', endsOn: '2026-12-01', today: '2026-08-06', graceDays: 7, hasOutstandingBalance: false })).toBe('active');
  });
});
