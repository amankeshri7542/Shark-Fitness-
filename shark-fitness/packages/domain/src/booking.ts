import type { BookingEligibility } from '@shark/contracts';

/**
 * Booking rules — PF-SCH. Pure decisions; the transactional last-seat claim
 * lives in the repository layer, which is the single concurrency authority.
 * This module decides *whether* a claim should be attempted and why not.
 */

export interface EligibilityInput {
  now: Date;
  startsAt: Date;
  /** Branch-local policy, evaluated against branch-local class time. */
  bookingOpensAt: Date | null;
  cancelDeadlineAt: Date | null;
  capacity: number;
  booked: number;
  sessionCancelled: boolean;
  membershipEntitled: boolean;
  membershipReason: string | null;
  branchPermitted: boolean;
  creditsRequired: number;
  creditsHeld: number;
  dropInPriceMinor: number | null;
  lateCancelFeeMinor: number;
  alreadyBooked: boolean;
  onWaitlist: boolean;
  conflictsWithSessionId: string | null;
  waitlistEnabled: boolean;
}

export function evaluateEligibility(i: EligibilityInput): BookingEligibility {
  const base = {
    creditsRequired: i.creditsRequired,
    creditsHeld: i.creditsHeld,
    dropInPriceMinor: i.dropInPriceMinor,
    bookingOpensAt: i.bookingOpensAt?.toISOString() ?? null,
    cancelDeadlineAt: i.cancelDeadlineAt?.toISOString() ?? null,
    lateCancelFeeMinor: i.lateCancelFeeMinor,
    conflictsWithSessionId: i.conflictsWithSessionId,
  };

  if (i.alreadyBooked) {
    const canCancelFree = i.cancelDeadlineAt ? i.now < i.cancelDeadlineAt : true;
    return {
      ...base,
      canBook: false,
      action: 'cancel',
      reason: canCancelFree
        ? `Booked. Free cancellation until ${formatTime(i.cancelDeadlineAt)}.`
        : `Booked. Cancelling now counts as a late cancellation.`,
    };
  }

  if (i.sessionCancelled) {
    return { ...base, canBook: false, action: 'blocked', reason: 'This class was cancelled.' };
  }

  if (i.startsAt <= i.now) {
    return { ...base, canBook: false, action: 'closed', reason: 'This class has already started.' };
  }

  if (!i.membershipEntitled) {
    return {
      ...base,
      canBook: false,
      action: 'blocked',
      reason: i.membershipReason ?? 'Your membership does not cover bookings right now.',
    };
  }

  if (!i.branchPermitted) {
    return {
      ...base,
      canBook: false,
      action: 'blocked',
      reason: 'Your membership does not include this branch.',
    };
  }

  if (i.bookingOpensAt && i.now < i.bookingOpensAt) {
    return {
      ...base,
      canBook: false,
      action: 'closed',
      reason: `Booking opens ${formatWhen(i.bookingOpensAt)}.`,
    };
  }

  if (i.conflictsWithSessionId) {
    return {
      ...base,
      canBook: false,
      action: 'blocked',
      reason: 'You already have a booking that overlaps this time.',
    };
  }

  const full = i.booked >= i.capacity;
  if (full) {
    if (i.onWaitlist) {
      return { ...base, canBook: false, action: 'blocked', reason: 'You are on the waitlist.' };
    }
    return i.waitlistEnabled
      ? { ...base, canBook: true, action: 'waitlist', reason: 'Class is full. Join the waitlist.' }
      : { ...base, canBook: false, action: 'blocked', reason: 'Class is full.' };
  }

  if (i.creditsRequired > 0 && i.creditsHeld < i.creditsRequired) {
    if (i.dropInPriceMinor !== null) {
      return {
        ...base,
        canBook: true,
        action: 'pay',
        reason: `Needs ${i.creditsRequired} class ${i.creditsRequired === 1 ? 'credit' : 'credits'} · you have ${i.creditsHeld}.`,
      };
    }
    return {
      ...base,
      canBook: false,
      action: 'blocked',
      reason: `Needs ${i.creditsRequired} class ${i.creditsRequired === 1 ? 'credit' : 'credits'} · you have ${i.creditsHeld}.`,
    };
  }

  const left = i.capacity - i.booked;
  return {
    ...base,
    canBook: true,
    action: 'book',
    reason: left <= 3 ? `${left} ${left === 1 ? 'seat' : 'seats'} left.` : 'Included in your membership.',
  };
}

/** Cancelling after the deadline is a late cancellation, which may carry a fee
 *  and always consumes the credit. Evaluated against branch-local class time. */
export function classifyCancellation(now: Date, cancelDeadlineAt: Date | null): {
  state: 'cancelled' | 'late_cancelled';
  refundCredit: boolean;
} {
  if (!cancelDeadlineAt || now < cancelDeadlineAt) {
    return { state: 'cancelled', refundCredit: true };
  }
  return { state: 'late_cancelled', refundCredit: false };
}

/**
 * Waitlist promotion. Promotion re-checks eligibility from scratch — a member
 * who lost their credits or membership while waiting is skipped, not promoted
 * into a broken booking (PF-SCH "Promotion must re-check eligibility").
 */
export interface WaitlistCandidate {
  id: string;
  memberId: string;
  position: number;
  eligible: boolean;
  skipReason: string | null;
}

export interface PromotionPlan {
  offer: WaitlistCandidate | null;
  skipped: Array<{ id: string; reason: string }>;
  offerWindowMin: number;
}

export function planPromotion(
  queue: WaitlistCandidate[],
  offerWindowMin = 15,
): PromotionPlan {
  const ordered = [...queue].sort((a, b) => a.position - b.position);
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const c of ordered) {
    if (c.eligible) return { offer: c, skipped, offerWindowMin };
    skipped.push({ id: c.id, reason: c.skipReason ?? 'No longer eligible' });
  }
  return { offer: null, skipped, offerWindowMin };
}

/** A hold that has expired does not occupy a seat. Capacity maths must use
 *  this rather than counting rows blindly. */
export function holdIsLive(heldAt: Date, now: Date, holdSeconds = 120): boolean {
  return now.getTime() - heldAt.getTime() < holdSeconds * 1000;
}

function formatTime(d: Date | null): string {
  if (!d) return 'the start of class';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatWhen(d: Date): string {
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
