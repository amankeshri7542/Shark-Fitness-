import type { MembershipState } from '@shark/contracts';

/**
 * Membership state machine — PF §"Membership state machine".
 *
 * The table is the specification. A transition that is not listed cannot
 * happen, and every attempt returns a reason rather than throwing, so callers
 * can surface it to staff instead of swallowing it.
 */
const TRANSITIONS: Record<MembershipState, MembershipState[]> = {
  draft: ['pending_payment', 'active', 'cancelled'],
  pending_payment: ['active', 'cancelled', 'expired'],
  active: ['frozen', 'grace', 'cancel_scheduled', 'suspended', 'expired'],
  frozen: ['active', 'suspended', 'cancel_scheduled', 'expired'],
  grace: ['active', 'expired', 'suspended', 'cancel_scheduled'],
  cancel_scheduled: ['cancelled', 'active'],
  suspended: ['active', 'frozen', 'grace', 'cancelled', 'expired'],
  // Terminal. Rejoining creates a NEW membership linked to this one; it is not
  // a transition on this record (PF §"Rejoining creates a new membership").
  cancelled: [],
  expired: [],
};

export interface TransitionRequest {
  from: MembershipState;
  to: MembershipState;
  reason: string;
  actorRole: 'staff' | 'member' | 'system' | 'provider';
}

export type TransitionOutcome =
  | { ok: true }
  | { ok: false; code: 'ILLEGAL_TRANSITION' | 'REASON_REQUIRED' | 'TERMINAL_STATE'; message: string };

export function canTransition(req: TransitionRequest): TransitionOutcome {
  const allowed = TRANSITIONS[req.from];
  if (allowed.length === 0) {
    return {
      ok: false,
      code: 'TERMINAL_STATE',
      message: `A ${req.from} membership cannot change state. Create a new membership to rejoin.`,
    };
  }
  if (!allowed.includes(req.to)) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `A membership cannot go from ${req.from} to ${req.to}.`,
    };
  }
  // Suspension is an access decision with consequences; it always needs a why.
  if ((req.to === 'suspended' || req.to === 'cancelled') && req.reason.trim().length < 4) {
    return { ok: false, code: 'REASON_REQUIRED', message: 'Give a reason for this change.' };
  }
  return { ok: true };
}

export const TERMINAL_STATES: MembershipState[] = ['cancelled', 'expired'];

/** States that let a member through the door, before outstanding-balance and
 *  branch checks run. `grace` is included on purpose — grace exists so a failed
 *  payment does not lock someone out on day one. */
export const ENTITLED_STATES: MembershipState[] = ['active', 'grace'];

export function isEntitled(state: MembershipState): boolean {
  return ENTITLED_STATES.includes(state);
}

/**
 * Freeze arithmetic. A freeze only pushes the end date out when the purchased
 * product version says so — the catalogue changing later must not retroactively
 * alter someone's terms (PF-CAT-003).
 */
export interface FreezeInput {
  endsOn: string | null;
  freezeDays: number;
  daysUsed: number;
  maxDaysPerTerm: number;
  minDaysPerFreeze: number;
  extendsExpiry: boolean;
  allowed: boolean;
}

export type FreezeOutcome =
  | { ok: true; newEndsOn: string | null; daysUsed: number }
  | { ok: false; message: string };

export function applyFreeze(input: FreezeInput): FreezeOutcome {
  if (!input.allowed) {
    return { ok: false, message: 'This membership cannot be frozen.' };
  }
  if (input.freezeDays < input.minDaysPerFreeze) {
    return { ok: false, message: `Freezes run for at least ${input.minDaysPerFreeze} days.` };
  }
  const totalAfter = input.daysUsed + input.freezeDays;
  if (totalAfter > input.maxDaysPerTerm) {
    const left = Math.max(0, input.maxDaysPerTerm - input.daysUsed);
    return {
      ok: false,
      message:
        left === 0
          ? 'This membership has used all of its freeze days for the term.'
          : `Only ${left} freeze ${left === 1 ? 'day is' : 'days are'} left this term.`,
    };
  }
  let newEndsOn = input.endsOn;
  if (input.extendsExpiry && input.endsOn) {
    newEndsOn = addDays(input.endsOn, input.freezeDays);
  }
  return { ok: true, newEndsOn, daysUsed: totalAfter };
}

/**
 * Proration on an upgrade. Charges the difference for the unused remainder of
 * the current term, rounded to the minor unit, never below zero — a downgrade
 * produces a credit note, which is a separate decision from this calculation.
 */
export interface ProrationInput {
  currentPriceMinor: number;
  newPriceMinor: number;
  daysRemaining: number;
  termDays: number;
}

export function prorate(input: ProrationInput): { chargeMinor: number; creditMinor: number } {
  if (input.termDays <= 0) return { chargeMinor: 0, creditMinor: 0 };
  const remainingRatio = Math.max(0, Math.min(1, input.daysRemaining / input.termDays));
  const unusedCurrent = Math.round(input.currentPriceMinor * remainingRatio);
  const costOfNew = Math.round(input.newPriceMinor * remainingRatio);
  const diff = costOfNew - unusedCurrent;
  return diff >= 0 ? { chargeMinor: diff, creditMinor: 0 } : { chargeMinor: 0, creditMinor: -diff };
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Which state a membership should be in today, given its dates. Run by the
 * expiry cron and on read, so a stale row never grants access it should not.
 */
export function deriveState(args: {
  current: MembershipState;
  endsOn: string | null;
  today: string;
  graceDays: number;
  hasOutstandingBalance: boolean;
}): MembershipState {
  const { current, endsOn, today, graceDays, hasOutstandingBalance } = args;
  if (TERMINAL_STATES.includes(current)) return current;
  if (current === 'frozen' || current === 'suspended') return current;
  if (!endsOn) return current;

  const overdueBy = daysBetween(endsOn, today);
  if (overdueBy <= 0) {
    return current === 'grace' && !hasOutstandingBalance ? 'active' : current;
  }
  if (overdueBy <= graceDays) return 'grace';
  return 'expired';
}
