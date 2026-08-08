import type { AccessDecision } from '@shark/contracts';
import { isEntitled } from './membership.js';
import type { MembershipState } from '@shark/contracts';

/**
 * Door decisions — PF-ATT-002. Every check runs server-side, in this order.
 * The order matters: a member should be told the most actionable reason, so
 * "settle your balance" beats "you are at the wrong branch" only when the
 * branch is actually right.
 */

export interface AccessInput {
  membershipState: MembershipState;
  permittedBranchIds: string[];
  branchId: string;
  /** Minutes past midnight, branch-local. */
  nowMinutes: number;
  opensMinutes: number;
  closesMinutes: number;
  /** Product-level window, null when the plan has no time restriction. */
  windowStartMin: number | null;
  windowEndMin: number | null;
  outstandingMinor: number;
  graceAllowsEntry: boolean;
  occupancy: number;
  capacity: number;
  tokenValid: boolean;
  tokenReplayed: boolean;
  /** Seconds since this member's last check-in at any branch. */
  secondsSinceLastCheckIn: number | null;
  antiPassbackSeconds: number;
  alreadyInside: boolean;
}

export interface AccessOutcome {
  decision: AccessDecision;
  granted: boolean;
  /** Staff with the right permission may override a denial with a reason. */
  overridable: boolean;
}

export function decideAccess(i: AccessInput): AccessOutcome {
  if (!i.tokenValid) {
    return { decision: 'denied_token_invalid', granted: false, overridable: true };
  }
  // A screenshot replays a burnt nonce. Never overridable — the fix is to open
  // the app, not to wave a member through on a stale code.
  if (i.tokenReplayed) {
    return { decision: 'denied_token_replayed', granted: false, overridable: false };
  }

  if (i.membershipState === 'suspended') {
    return { decision: 'denied_suspended', granted: false, overridable: true };
  }

  if (!isEntitled(i.membershipState)) {
    return { decision: 'denied_membership_inactive', granted: false, overridable: true };
  }

  if (!i.permittedBranchIds.includes(i.branchId)) {
    return { decision: 'denied_branch_not_permitted', granted: false, overridable: true };
  }

  if (i.membershipState === 'grace' && i.outstandingMinor > 0 && !i.graceAllowsEntry) {
    return { decision: 'denied_grace_outstanding', granted: false, overridable: true };
  }

  const windowStart = i.windowStartMin ?? i.opensMinutes;
  const windowEnd = i.windowEndMin ?? i.closesMinutes;
  if (i.nowMinutes < windowStart || i.nowMinutes >= windowEnd) {
    return { decision: 'denied_outside_hours', granted: false, overridable: true };
  }

  // Re-entry by someone already inside is a check-out, handled by the caller —
  // anti-passback only applies to a fresh entry.
  if (
    !i.alreadyInside &&
    i.secondsSinceLastCheckIn !== null &&
    i.secondsSinceLastCheckIn < i.antiPassbackSeconds
  ) {
    return { decision: 'denied_anti_passback', granted: false, overridable: true };
  }

  if (i.occupancy >= i.capacity) {
    return { decision: 'denied_capacity', granted: false, overridable: true };
  }

  return { decision: 'granted', granted: true, overridable: false };
}

/** Member-facing copy for a denial. Explains what to do without exposing
 *  security detail (Design PRD "Content design"). Always the plain register. */
export const DENIAL_COPY: Record<Exclude<AccessDecision, 'granted'>, string> = {
  denied_membership_inactive:
    'Your membership is not active. Reception can sort this out in a minute.',
  denied_grace_outstanding:
    'There is an unpaid balance on your account. Settle it here or at reception to get back in.',
  denied_branch_not_permitted: 'Your plan does not include this branch yet.',
  denied_outside_hours: 'Your plan does not cover this time of day.',
  denied_capacity: 'The gym is at capacity right now. Try again shortly.',
  denied_suspended: 'Your access is on hold. Please speak to reception.',
  denied_anti_passback: 'You checked in moments ago. Ask reception if this looks wrong.',
  denied_token_invalid: 'This code has expired. Open the app to show a fresh one.',
  denied_token_replayed: 'This code has already been used. Open the app for a new one.',
};

export function occupancyLabel(inside: number, capacity: number): 'quiet' | 'steady' | 'busy' | 'peak' {
  if (capacity <= 0) return 'quiet';
  const pct = inside / capacity;
  if (pct < 0.3) return 'quiet';
  if (pct < 0.6) return 'steady';
  if (pct < 0.85) return 'busy';
  return 'peak';
}

/**
 * Rotating entry code. The client holds a seed and derives the code from the
 * current time window, so it keeps rotating with no network. The server derives
 * the same value and burns the window, which is what makes a screenshot useless
 * and a replay detectable (PF-ATT-005).
 */
export const ROTATE_SECONDS = 30;

export function deriveCode(seed: string, epochSeconds: number, rotateSec = ROTATE_SECONDS): string {
  const window = Math.floor(epochSeconds / rotateSec);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `${seed}:${window}`;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ input.charCodeAt(i), 0x85ebca6b) >>> 0) + i;
    h2 >>>= 0;
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  let n = (h1 ^ Math.imul(h2, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < 5; i++) {
    out += alphabet[n % 32];
    n = Math.floor(n / 32) + (i === 2 ? h2 % 977 : 0);
  }
  let m = h2 >>> 0;
  for (let i = 0; i < 5; i++) {
    out += alphabet[m % 32];
    m = Math.floor(m / 32) + (i === 2 ? h1 % 991 : 0);
  }
  return out;
}

export function secondsUntilRotation(epochSeconds: number, rotateSec = ROTATE_SECONDS): number {
  return rotateSec - (epochSeconds % rotateSec);
}
