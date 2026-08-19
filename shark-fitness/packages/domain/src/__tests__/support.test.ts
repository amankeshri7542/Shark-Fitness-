import { describe, expect, it } from 'vitest';
import {
  canTransitionTicket,
  csatSummary,
  interventionEffectiveness,
  npsSummary,
  slaDeadline,
  slaView,
  transitionRefusal,
} from '../support.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* ============================================================================
   Support desk rules — PF-SUP-001, 002, 004, 006.

   These are the parts that are awkward to reason about in a browser: a promise
   made across a closing time, a verdict that must not change once it is a fact
   about the past, and a rate that is honest about how little it knows.
   ========================================================================= */

/* — A branch open 06:00–22:00, never on holiday — */
const OPEN_0600_2200 = {
  hours: { opensMinutes: 6 * 60, closesMinutes: 22 * 60 },
  closedOn: () => false,
};

/** Minutes past midnight, treating the epoch as midnight for readability. */
const localMinutesAt = (ms: number): number => Math.floor(ms / MINUTE) % (24 * 60);

describe('slaDeadline — the clock runs in open hours', () => {
  it('behaves like wall-clock while the branch is open', () => {
    const openedAt = 8 * HOUR; // 08:00
    const due = slaDeadline({ openedAt, responseMinutes: 240, ...OPEN_0600_2200, localMinutesAt });
    expect(due).toBe(openedAt + 4 * HOUR); // 12:00, nothing skipped
  });

  it('pauses overnight rather than falling due while nobody is there', () => {
    // 21:00 with a four-hour promise. One hour of open time is left today, so
    // the deadline lands three hours after tomorrow's 06:00 — 09:00, not 01:00.
    const openedAt = 21 * HOUR;
    const due = slaDeadline({ openedAt, responseMinutes: 240, ...OPEN_0600_2200, localMinutesAt })!;
    expect(localMinutesAt(due)).toBe(9 * 60);
    // And it is genuinely later in wall-clock terms than the naive answer.
    expect(due).toBeGreaterThan(openedAt + 4 * HOUR);
  });

  it('skips a day the branch is shut entirely', () => {
    const openedAt = 21 * HOUR;
    const dayTwo = Math.floor((openedAt + 24 * HOUR) / (24 * HOUR));
    const withHoliday = slaDeadline({
      openedAt,
      responseMinutes: 240,
      hours: OPEN_0600_2200.hours,
      localMinutesAt,
      // Tomorrow is a holiday, so the promise runs into the day after.
      closedOn: (ms) => Math.floor(ms / (24 * HOUR)) === dayTwo,
    })!;
    const withoutHoliday = slaDeadline({ openedAt, responseMinutes: 240, ...OPEN_0600_2200, localMinutesAt })!;
    expect(withHoliday).toBeGreaterThan(withoutHoliday);
    expect(withHoliday - withoutHoliday).toBeGreaterThanOrEqual(20 * HOUR);
  });

  it('never pauses for a branch that is open around the clock', () => {
    const openedAt = 23 * HOUR;
    const due = slaDeadline({
      openedAt,
      responseMinutes: 240,
      hours: { opensMinutes: 0, closesMinutes: 1440 },
      localMinutesAt,
      closedOn: () => false,
    });
    expect(due).toBe(openedAt + 4 * HOUR);
  });

  it('handles a branch whose hours wrap past midnight', () => {
    // 22:00–02:00. Opened at 23:00, a two-hour promise ends at 01:00 without
    // the window being read as minus twenty hours long.
    const openedAt = 23 * HOUR;
    const due = slaDeadline({
      openedAt,
      responseMinutes: 120,
      hours: { opensMinutes: 22 * 60, closesMinutes: 2 * 60 },
      localMinutesAt,
      closedOn: () => false,
    })!;
    expect(localMinutesAt(due)).toBe(60);
  });

  it('reports a promise it cannot meet rather than inventing a date', () => {
    const due = slaDeadline({
      openedAt: 0,
      responseMinutes: 240,
      hours: { opensMinutes: 6 * 60, closesMinutes: 22 * 60 },
      localMinutesAt,
      // A branch that is never open. A deadline here would be a fiction.
      closedOn: () => true,
    });
    expect(due).toBeNull();
  });
});

describe('slaView — the verdict is derived, and fixed once it is history', () => {
  const base = { state: 'open', slaDueAt: 100 * HOUR, firstResponseAt: null, now: 90 * HOUR };

  it('counts down while nothing has been answered', () => {
    const view = slaView(base);
    expect(view.state).toBe('on_track');
    expect(view.breached).toBe(false);
    expect(view.dueInMinutes).toBe(600);
  });

  it('warns close to the deadline', () => {
    expect(slaView({ ...base, now: 100 * HOUR - 30 * MINUTE }).state).toBe('due_soon');
  });

  it('breaches once past it', () => {
    const view = slaView({ ...base, now: 103 * HOUR });
    expect(view.state).toBe('breached');
    expect(view.breached).toBe(true);
    expect(view.label).toMatch(/overdue/);
  });

  it('freezes the verdict at the first reply, however long the ticket then stays open', () => {
    // A desk that answers in twenty minutes and spends a week fixing a boiler
    // has kept its promise. Anything else and the measure gets ignored.
    const answered = { ...base, firstResponseAt: 91 * HOUR, now: 500 * HOUR };
    const view = slaView(answered);
    expect(view.state).toBe('met');
    expect(view.breached).toBe(false);
  });

  it('keeps a late first reply late for ever', () => {
    const view = slaView({ ...base, firstResponseAt: 120 * HOUR, now: 5000 * HOUR });
    expect(view.state).toBe('breached');
    expect(view.label).toMatch(/late/);
  });

  it('will not let closing a never-answered ticket launder the breach', () => {
    const view = slaView({ ...base, state: 'closed', firstResponseAt: null, now: 200 * HOUR });
    expect(view.breached).toBe(true);
  });

  it('says so plainly when nothing was promised', () => {
    const view = slaView({ ...base, slaDueAt: null });
    expect(view.state).toBe('none');
    expect(view.dueInMinutes).toBeNull();
  });
});

describe('Ticket transitions', () => {
  it('separates waiting on us from waiting on the member', () => {
    expect(canTransitionTicket('open', 'pending_staff')).toBe(true);
    expect(canTransitionTicket('pending_member', 'pending_staff')).toBe(true);
  });

  it('allows a resolved ticket to be reopened, because disputes come back', () => {
    expect(canTransitionTicket('resolved', 'open')).toBe(true);
  });

  it('treats closed as terminal and says why', () => {
    expect(canTransitionTicket('closed', 'open')).toBe(false);
    expect(transitionRefusal('closed', 'open')).toMatch(/settled record/i);
  });

  it('refuses a no-op in the words a person would use', () => {
    expect(transitionRefusal('pending_member', 'pending_member')).toMatch(/already waiting on the member/i);
  });
});

describe('interventionEffectiveness', () => {
  const rows = (spec: Array<[string, string | null]>) =>
    spec.map(([action, outcome]) => ({ action, outcome, riskBandAtCreation: 'high' }));

  it('excludes unreachable members from the rate rather than counting them as failures', () => {
    // Three judged (2 retained, 1 churned) plus two that tested nothing.
    const [call] = interventionEffectiveness(
      rows([
        ['call', 'retained'],
        ['call', 'retained'],
        ['call', 'churned'],
        ['call', 'no_contact'],
        ['call', 'false_positive'],
      ]),
    );
    expect(call!.attempted).toBe(5);
    expect(call!.noContact).toBe(1);
    expect(call!.falsePositive).toBe(1);
    // 2 of 3 judged, not 2 of 5.
    expect(call!.retentionRate).toBe(67);
  });

  it('withholds a rate until there is enough to divide by', () => {
    const [call] = interventionEffectiveness(rows([['call', 'retained'], ['call', 'churned']]));
    expect(call!.retentionRate).toBeNull();
  });

  it('counts still-open work as pending rather than as a result', () => {
    const [call] = interventionEffectiveness(rows([['call', null], ['call', null]]));
    expect(call!.pending).toBe(2);
    expect(call!.retentionRate).toBeNull();
  });

  it('reports the most-used action first', () => {
    const out = interventionEffectiveness(
      rows([['coach_checkin', 'retained'], ['call', 'retained'], ['call', 'retained'], ['call', 'churned']]),
    );
    expect(out[0]!.action).toBe('call');
  });
});

describe('npsSummary', () => {
  it('uses promoters minus detractors, not an average of the answers', () => {
    // 3 promoters, 1 passive, 1 detractor over 5 → (3−1)/5 = 40.
    const out = npsSummary([10, 9, 9, 8, 4]);
    expect(out.promoters).toBe(3);
    expect(out.passives).toBe(1);
    expect(out.detractors).toBe(1);
    expect(out.score).toBe(40);
  });

  it('withholds the score under the reporting floor', () => {
    // −100 from one grumpy answer is true and completely useless.
    const out = npsSummary([2]);
    expect(out.responses).toBe(1);
    expect(out.score).toBeNull();
  });

  it('ignores values outside the 0–10 scale rather than skewing the result', () => {
    expect(npsSummary([10, 9, 9, 8, 4, 99, -3]).responses).toBe(5);
  });
});

describe('csatSummary', () => {
  it('reports the mean and the satisfied share once there is enough', () => {
    const out = csatSummary([5, 4, 5, 3, 5]);
    expect(out.average).toBe(4.4);
    expect(out.satisfiedPct).toBe(80);
  });

  it('withholds both under the floor', () => {
    const out = csatSummary([5, 4]);
    expect(out.average).toBeNull();
    expect(out.satisfiedPct).toBeNull();
  });
});

/* ============================================================================
   Risk labels are read by people (PF-SUP-003).

   These live here rather than in `fairness.test.ts` because Phase 9 is what
   put the labels on a screen; the arithmetic was always right and one of the
   sentences was always wrong.
   ========================================================================= */

describe('retentionRisk labels', () => {
  const base = {
    weeklySessions: [0, 0, 0, 0] as [number, number, number, number],
    baselineWeekly: 3,
    daysSinceLastVisit: 5,
    hasFailedPayment: false,
    autoRenew: false,
    unansweredCoachMessages: 0,
    openComplaints: 0,
    branchClosedWeeks: 0,
    daysSinceJoined: 400,
  };

  it('says a lapsed membership expired, not that it "expires in -5 days"', async () => {
    const { retentionRisk } = await import('../retention.js');
    const r = retentionRisk({ ...base, daysUntilExpiry: -5 });
    const reason = r.reasons.find((x) => x.code === 'expiring_no_renew');
    expect(reason?.label).toBe('Expired 5 days ago with auto-renew off');
  });

  it('still reads forwards while there is time left', async () => {
    const { retentionRisk } = await import('../retention.js');
    const r = retentionRisk({ ...base, daysUntilExpiry: 12 });
    expect(r.reasons.find((x) => x.code === 'expiring_no_renew')?.label).toBe(
      'Expires in 12 days with auto-renew off',
    );
  });

  it('gets the singular right on the last day', async () => {
    const { retentionRisk } = await import('../retention.js');
    const r = retentionRisk({ ...base, daysUntilExpiry: 1 });
    expect(r.reasons.find((x) => x.code === 'expiring_no_renew')?.label).toBe(
      'Expires in 1 day with auto-renew off',
    );
  });
});
