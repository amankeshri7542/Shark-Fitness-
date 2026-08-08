import { describe, expect, it } from 'vitest';
import { classifyCancellation, evaluateEligibility, holdIsLive, planPromotion } from '../booking.js';
import type { EligibilityInput } from '../booking.js';

const at = (iso: string) => new Date(iso);

const base: EligibilityInput = {
  now: at('2026-08-06T09:00:00Z'),
  startsAt: at('2026-08-06T13:30:00Z'),
  bookingOpensAt: at('2026-08-05T13:30:00Z'),
  cancelDeadlineAt: at('2026-08-06T11:30:00Z'),
  capacity: 18,
  booked: 12,
  sessionCancelled: false,
  membershipEntitled: true,
  membershipReason: null,
  branchPermitted: true,
  creditsRequired: 0,
  creditsHeld: 0,
  dropInPriceMinor: null,
  lateCancelFeeMinor: 0,
  alreadyBooked: false,
  onWaitlist: false,
  conflictsWithSessionId: null,
  waitlistEnabled: true,
};

describe('booking eligibility', () => {
  it('offers a seat when one is free and the plan covers it', () => {
    const r = evaluateEligibility(base);
    expect(r.action).toBe('book');
    expect(r.canBook).toBe(true);
  });

  it('offers the waitlist rather than a dead button when full', () => {
    const r = evaluateEligibility({ ...base, booked: 18 });
    expect(r.action).toBe('waitlist');
    expect(r.canBook).toBe(true);
  });

  it('says how many credits are missing rather than just refusing', () => {
    const r = evaluateEligibility({ ...base, creditsRequired: 1, creditsHeld: 0, dropInPriceMinor: 35_000 });
    expect(r.action).toBe('pay');
    expect(r.reason).toBe('Needs 1 class credit · you have 0.');
  });

  it('blocks rather than upsells when there is no drop-in price', () => {
    const r = evaluateEligibility({ ...base, creditsRequired: 1, creditsHeld: 0, dropInPriceMinor: null });
    expect(r.action).toBe('blocked');
    expect(r.canBook).toBe(false);
  });

  it('closes booking before the window opens', () => {
    const r = evaluateEligibility({ ...base, bookingOpensAt: at('2026-08-06T18:00:00Z') });
    expect(r.action).toBe('closed');
  });

  it('refuses an overlapping booking', () => {
    const r = evaluateEligibility({ ...base, conflictsWithSessionId: 'ses_1' });
    expect(r.action).toBe('blocked');
    expect(r.reason).toContain('overlaps');
  });

  it('explains the membership problem it was given, not a generic refusal', () => {
    const r = evaluateEligibility({
      ...base,
      membershipEntitled: false,
      membershipReason: 'Your membership is in its grace period.',
    });
    expect(r.reason).toBe('Your membership is in its grace period.');
  });

  it('shows cancel with a free-cancellation deadline for an existing booking', () => {
    const r = evaluateEligibility({ ...base, alreadyBooked: true });
    expect(r.action).toBe('cancel');
    expect(r.reason).toContain('Free cancellation');
  });

  it('warns that cancelling is now late once the deadline has passed', () => {
    const r = evaluateEligibility({
      ...base,
      alreadyBooked: true,
      now: at('2026-08-06T12:00:00Z'),
    });
    expect(r.reason).toContain('late cancellation');
  });
});

describe('cancellation classification', () => {
  it('refunds the credit before the deadline', () => {
    expect(classifyCancellation(at('2026-08-06T10:00:00Z'), at('2026-08-06T11:30:00Z')))
      .toEqual({ state: 'cancelled', refundCredit: true });
  });

  it('keeps the credit after the deadline', () => {
    expect(classifyCancellation(at('2026-08-06T12:00:00Z'), at('2026-08-06T11:30:00Z')))
      .toEqual({ state: 'late_cancelled', refundCredit: false });
  });
});

describe('waitlist promotion', () => {
  it('offers the seat to the first person who is still eligible', () => {
    const plan = planPromotion([
      { id: 'w2', memberId: 'm2', position: 2, eligible: true, skipReason: null },
      { id: 'w1', memberId: 'm1', position: 1, eligible: false, skipReason: 'No credits left' },
    ]);
    expect(plan.offer?.id).toBe('w2');
    expect(plan.skipped).toEqual([{ id: 'w1', reason: 'No credits left' }]);
  });

  it('offers nobody when the whole queue has become ineligible', () => {
    const plan = planPromotion([
      { id: 'w1', memberId: 'm1', position: 1, eligible: false, skipReason: 'Membership expired' },
    ]);
    expect(plan.offer).toBeNull();
    expect(plan.skipped).toHaveLength(1);
  });
});

describe('holds', () => {
  it('stops occupying a seat once it expires', () => {
    const held = at('2026-08-06T09:00:00Z');
    expect(holdIsLive(held, at('2026-08-06T09:01:00Z'))).toBe(true);
    expect(holdIsLive(held, at('2026-08-06T09:03:00Z'))).toBe(false);
  });
});
