import { describe, expect, it } from 'vitest';
import { decideAccess, deriveCode, occupancyLabel, secondsUntilRotation } from '../access.js';
import type { AccessInput } from '../access.js';

const base: AccessInput = {
  membershipState: 'active',
  permittedBranchIds: ['br_kor'],
  branchId: 'br_kor',
  nowMinutes: 9 * 60 + 41,
  opensMinutes: 5 * 60,
  closesMinutes: 23 * 60,
  windowStartMin: null,
  windowEndMin: null,
  outstandingMinor: 0,
  graceAllowsEntry: true,
  occupancy: 42,
  capacity: 120,
  tokenValid: true,
  tokenReplayed: false,
  secondsSinceLastCheckIn: null,
  antiPassbackSeconds: 90,
  alreadyInside: false,
};

describe('door decisions', () => {
  it('lets an entitled member in', () => {
    expect(decideAccess(base)).toEqual({ decision: 'granted', granted: true, overridable: false });
  });

  it('refuses a replayed code and does not let staff wave it through', () => {
    const r = decideAccess({ ...base, tokenReplayed: true });
    expect(r.decision).toBe('denied_token_replayed');
    expect(r.overridable).toBe(false);
  });

  it('refuses a member entitled only to another branch', () => {
    expect(decideAccess({ ...base, permittedBranchIds: ['br_indira'] }).decision)
      .toBe('denied_branch_not_permitted');
  });

  it('refuses a grace member with an outstanding balance when grace entry is off', () => {
    const r = decideAccess({
      ...base,
      membershipState: 'grace',
      outstandingMinor: 249_900,
      graceAllowsEntry: false,
    });
    expect(r.decision).toBe('denied_grace_outstanding');
    expect(r.overridable).toBe(true);
  });

  it('lets a grace member in when the tenant allows grace entry', () => {
    expect(
      decideAccess({ ...base, membershipState: 'grace', outstandingMinor: 249_900, graceAllowsEntry: true }).granted,
    ).toBe(true);
  });

  it('applies the product time window over the branch hours', () => {
    const offPeakOnly = { ...base, windowStartMin: 10 * 60, windowEndMin: 16 * 60 };
    expect(decideAccess(offPeakOnly).decision).toBe('denied_outside_hours');
    expect(decideAccess({ ...offPeakOnly, nowMinutes: 11 * 60 }).granted).toBe(true);
  });

  it('blocks a rapid duplicate scan but not a check-out by someone inside', () => {
    expect(decideAccess({ ...base, secondsSinceLastCheckIn: 20 }).decision).toBe('denied_anti_passback');
    expect(decideAccess({ ...base, secondsSinceLastCheckIn: 20, alreadyInside: true }).granted).toBe(true);
  });

  it('refuses entry at capacity', () => {
    expect(decideAccess({ ...base, occupancy: 120, capacity: 120 }).decision).toBe('denied_capacity');
  });

  it('checks suspension before anything a member could self-serve', () => {
    expect(decideAccess({ ...base, membershipState: 'suspended', outstandingMinor: 5000 }).decision)
      .toBe('denied_suspended');
  });
});

describe('rotating entry code', () => {
  it('is stable inside a window and changes across windows', () => {
    const seed = 'seed-4417';
    // 999_990–1_000_019 is one 30s window; 1_000_020 starts the next.
    const a = deriveCode(seed, 1_000_000);
    const sameWindow = deriveCode(seed, 1_000_019);
    const nextWindow = deriveCode(seed, 1_000_020);
    expect(a).toBe(sameWindow);
    expect(a).not.toBe(nextWindow);
  });

  it('differs per member', () => {
    expect(deriveCode('seed-a', 1_000_000)).not.toBe(deriveCode('seed-b', 1_000_000));
  });

  it('is 10 characters of an unambiguous alphabet', () => {
    const code = deriveCode('seed-4417', 1_234_567);
    expect(code).toHaveLength(10);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    expect(code).not.toMatch(/[OI01]/);
  });

  it('counts down to the next rotation', () => {
    expect(secondsUntilRotation(999_990)).toBe(30);
    expect(secondsUntilRotation(1_000_000)).toBe(20);
    expect(secondsUntilRotation(1_000_019)).toBe(1);
  });
});

describe('occupancy labels', () => {
  it('bands sensibly', () => {
    expect(occupancyLabel(10, 120)).toBe('quiet');
    expect(occupancyLabel(50, 120)).toBe('steady');
    expect(occupancyLabel(85, 120)).toBe('busy');
    expect(occupancyLabel(115, 120)).toBe('peak');
  });
});
