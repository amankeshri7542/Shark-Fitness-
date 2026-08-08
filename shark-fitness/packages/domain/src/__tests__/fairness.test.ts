import { describe, expect, it } from 'vitest';
import {
  applyDailyCap,
  compensate,
  computeStreak,
  fairScore,
  isRankable,
  levelFor,
  RANKABLE_METRICS,
  referralIsSuspicious,
  XP_AWARDS,
} from '../gamification.js';
import { canSendAutomatedOutreach, retentionRisk } from '../retention.js';
import { goalPaceWarning, nutritionSafety, scanForSafety, blocksAutomation } from '../safety.js';
import { dunningPlan, formatMoney, insideQuietHours, invoiceStateFor, totalsFor } from '../money.js';

describe('levels', () => {
  it('places XP on the right rung and reports progress to the next', () => {
    const l = levelFor(4800);
    expect(l.level).toBe(7);
    expect(l.name).toBe('Tiger');
    expect(l.nextName).toBe('Great White');
    expect(l.progressPct).toBe(30);
  });

  it('clamps at the top rung', () => {
    const l = levelFor(999_999);
    expect(l.name).toBe('Apex');
    expect(l.nextName).toBeNull();
    expect(l.progressPct).toBe(100);
  });

  it('handles zero and negative XP without going out of range', () => {
    expect(levelFor(0).level).toBe(1);
    expect(levelFor(-50).xp).toBe(0);
  });
});

describe('XP fairness', () => {
  it('does not pay per set — a longer session earns the same as a shorter one', () => {
    // The award table has no volume-derived entry at all.
    expect(Object.keys(XP_AWARDS)).not.toContain('volume');
    expect(Object.keys(XP_AWARDS).some((k) => /set|volume|tonnage|kg/i.test(k))).toBe(false);
  });

  it('caps a day so nobody can farm it', () => {
    const awards = Array.from({ length: 6 }, () => ({
      delta: 120,
      reason: 'workout_completed' as const,
      refType: 'workout',
      refId: 'w1',
    }));
    const capped = applyDailyCap(awards, 0);
    expect(capped.reduce((a, b) => a + b.delta, 0)).toBe(400);
  });

  it('corrects by compensating entry, never by editing the original', () => {
    const c = compensate({ id: 'xp_1', delta: 120, reason: 'workout_completed' });
    expect(c.delta).toBe(-120);
    expect(c.isCorrection).toBe(true);
    expect(c.refId).toBe('xp_1');
  });
});

describe('challenge fairness', () => {
  it('will not rank volume lifted or any body metric', () => {
    expect(isRankable('volume')).toBe(false);
    expect(isRankable('tonnage')).toBe(false);
    expect(isRankable('body_fat')).toBe(false);
    expect(isRankable('weight_lost')).toBe(false);
    expect(RANKABLE_METRICS).toContain('sessions');
  });

  it('scores a late joiner on rate so joining late is not an automatic loss', () => {
    const early = fairScore({ rawCount: 20, daysParticipated: 20, daysElapsed: 20 });
    const late = fairScore({ rawCount: 10, daysParticipated: 10, daysElapsed: 20 });
    expect(late).toBe(early);
  });

  it('flags referral farming from one device', () => {
    expect(referralIsSuspicious({ sameDeviceCount: 3, joinedWithinMinutes: 60, sharedPaymentInstrument: false }).suspicious).toBe(true);
    expect(referralIsSuspicious({ sameDeviceCount: 1, joinedWithinMinutes: 600, sharedPaymentInstrument: false }).suspicious).toBe(false);
  });
});

describe('streaks', () => {
  it('survives a rest day inside the allowance', () => {
    const r = computeStreak({
      sessionDates: ['2026-08-06', '2026-08-04', '2026-08-02'],
      today: '2026-08-06',
      weeklyTarget: 4,
      restDaysAllowed: 2,
    });
    expect(r.current).toBe(3);
  });

  it('breaks on a gap longer than the allowance', () => {
    const r = computeStreak({
      sessionDates: ['2026-08-06', '2026-07-20'],
      today: '2026-08-06',
      weeklyTarget: 4,
      restDaysAllowed: 2,
    });
    expect(r.current).toBe(1);
  });

  it('reports zero rather than throwing for a new member', () => {
    const r = computeStreak({ sessionDates: [], today: '2026-08-06', weeklyTarget: 4, restDaysAllowed: 2 });
    expect(r.current).toBe(0);
    expect(r.lastSessionOn).toBeNull();
  });
});

describe('retention risk', () => {
  const base = {
    weeklySessions: [0, 0, 3, 4] as [number, number, number, number],
    baselineWeekly: 3.5,
    daysSinceLastVisit: 16,
    hasFailedPayment: false,
    daysUntilExpiry: 40,
    autoRenew: true,
    unansweredCoachMessages: 0,
    openComplaints: 0,
    branchClosedWeeks: 0,
    daysSinceJoined: 400,
  };

  it('ships reasons with the score, never a bare number', () => {
    const r = retentionRisk(base);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.every((x) => x.label.length > 0)).toBe(true);
    expect(r.recommendedAction.length).toBeGreaterThan(0);
  });

  it('refuses to score when the branch was shut for most of the window', () => {
    const r = retentionRisk({ ...base, branchClosedWeeks: 3 });
    expect(r.score).toBe(0);
    expect(r.suppressed).toContain('closed');
  });

  it('refuses to score a member who only just joined', () => {
    const r = retentionRisk({ ...base, daysSinceJoined: 10 });
    expect(r.suppressed).toContain('three weeks');
  });

  it('puts a failed payment ahead of the renewal pitch', () => {
    const r = retentionRisk({ ...base, hasFailedPayment: true });
    expect(r.recommendedAction).toContain('failed payment');
  });
});

describe('outreach guards', () => {
  const ok = {
    optedOut: false,
    insideQuietHours: false,
    messagesSentLast7d: 0,
    hasOpenComplaint: false,
    isVulnerabilityFlagged: false,
  };

  it('allows a normal send', () => {
    expect(canSendAutomatedOutreach(ok).allowed).toBe(true);
  });

  it('stops on opt-out, quiet hours, complaint, vulnerability and volume', () => {
    expect(canSendAutomatedOutreach({ ...ok, optedOut: true }).allowed).toBe(false);
    expect(canSendAutomatedOutreach({ ...ok, insideQuietHours: true }).allowed).toBe(false);
    expect(canSendAutomatedOutreach({ ...ok, hasOpenComplaint: true }).allowed).toBe(false);
    expect(canSendAutomatedOutreach({ ...ok, isVulnerabilityFlagged: true }).allowed).toBe(false);
    expect(canSendAutomatedOutreach({ ...ok, messagesSentLast7d: 3 }).allowed).toBe(false);
  });
});

describe('safety scanning', () => {
  it('spots an injury and pauses automated progression', () => {
    const s = scanForSafety('my shoulder is injured, sharp pain when pressing');
    expect(s.some((x) => x.category === 'injury')).toBe(true);
    expect(blocksAutomation(s)).toBe(true);
  });

  it('spots restriction language and routes it to a person', () => {
    const s = scanForSafety("I've been skipping meals to hit the number");
    expect(s.some((x) => x.category === 'disordered_eating')).toBe(true);
  });

  it('spots pregnancy and pauses progression', () => {
    expect(blocksAutomation(scanForSafety('I am pregnant, first trimester'))).toBe(true);
  });

  it('leaves ordinary training talk alone', () => {
    expect(scanForSafety('legs were sore but the session felt great')).toEqual([]);
  });

  it('refuses an unsafe calorie floor', () => {
    expect(nutritionSafety({ kcal: 900, sex: 'female', bodyweightKg: 60, proteinG: 120 })).toContain('1200 kcal');
    expect(nutritionSafety({ kcal: 2200, sex: 'male', bodyweightKg: 80, proteinG: 160 })).toBeNull();
  });

  it('warns on an unrealistic weight goal without blocking it', () => {
    const w = goalPaceWarning({ kind: 'bodyweight', baseline: 80, target: 70, daysRemaining: 28 });
    expect(w).toContain('a week');
  });
});

describe('money', () => {
  it('computes tax per line, not on a rounded subtotal', () => {
    const t = totalsFor([
      { quantity: 3, unitMinor: 333, taxRateBp: 1800 },
      { quantity: 1, unitMinor: 100, taxRateBp: 1800 },
    ]);
    expect(t.subtotalMinor).toBe(1099);
    expect(t.taxMinor).toBe(180 + 18);
    expect(t.totalMinor).toBe(1297);
  });

  it('applies a discount before tax', () => {
    const t = totalsFor([{ quantity: 1, unitMinor: 10_000, taxRateBp: 1800, discountMinor: 2_000 }]);
    expect(t.taxMinor).toBe(1_440);
    expect(t.totalMinor).toBe(9_440);
  });

  it('formats Indian rupees in the Indian grouping', () => {
    expect(formatMoney(249_900, 'INR')).toBe('₹2,499');
  });

  it('derives invoice state from the money, not from a flag someone forgot to set', () => {
    const args = { totalMinor: 1000, refundedMinor: 0, dueOn: '2026-08-01', voided: false };
    expect(invoiceStateFor({ ...args, paidMinor: 0, today: '2026-07-20' })).toBe('open');
    expect(invoiceStateFor({ ...args, paidMinor: 0, today: '2026-08-05' })).toBe('overdue');
    expect(invoiceStateFor({ ...args, paidMinor: 400, today: '2026-07-20' })).toBe('partially_paid');
    expect(invoiceStateFor({ ...args, paidMinor: 1000, today: '2026-08-05' })).toBe('paid');
    expect(invoiceStateFor({ ...args, paidMinor: 1000, refundedMinor: 1000, today: '2026-08-05' })).toBe('refunded');
    expect(invoiceStateFor({ ...args, paidMinor: 1000, voided: true, today: '2026-08-05' })).toBe('void');
  });

  it('backs off dunning attempts and raises a staff task at the end', () => {
    const plan = dunningPlan(['email', 'sms']);
    expect(plan.map((p) => p.offsetDays)).toEqual([0, 3, 7, 14]);
    expect(plan.at(-1)?.createsStaffTask).toBe(true);
  });

  it('knows what quiet hours are, across midnight', () => {
    expect(insideQuietHours(23 * 60)).toBe(true);
    expect(insideQuietHours(3 * 60)).toBe(true);
    expect(insideQuietHours(14 * 60)).toBe(false);
  });
});
