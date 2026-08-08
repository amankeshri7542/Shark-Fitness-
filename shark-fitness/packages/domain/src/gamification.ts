/**
 * XP, levels, streaks — PF-GAME.
 *
 * Two rules shape everything here:
 *   1. Every award is derived from an auditable event, and a correction is a
 *      compensating ledger entry, never an edit or a delete (PF-GAME-002).
 *   2. Fairness beats engagement. Nothing rewards volume, nobody is ranked on
 *      body metrics, and a streak does not punish someone for being ill
 *      (PF-GAME-004, product principle 9).
 */

export const LEVELS = [
  { level: 1, name: 'Minnow', xp: 0 },
  { level: 2, name: 'Reef', xp: 250 },
  { level: 3, name: 'Blacktip', xp: 600 },
  { level: 4, name: 'Bull', xp: 1100 },
  { level: 5, name: 'Mako', xp: 1800 },
  { level: 6, name: 'Hammerhead', xp: 2800 },
  { level: 7, name: 'Tiger', xp: 4200 },
  { level: 8, name: 'Great White', xp: 6200 },
  { level: 9, name: 'Megalodon', xp: 9000 },
  { level: 10, name: 'Apex', xp: 13000 },
] as const;

export interface LevelInfo {
  level: number;
  name: string;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  progressPct: number;
  nextName: string | null;
}

export function levelFor(xp: number): LevelInfo {
  const safeXp = Math.max(0, Math.floor(xp));
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (safeXp >= LEVELS[i]!.xp) idx = i;
  }
  const current = LEVELS[idx]!;
  const next = LEVELS[idx + 1] ?? null;
  const span = next ? next.xp - current.xp : 0;
  const into = safeXp - current.xp;
  return {
    level: current.level,
    name: current.name,
    xp: safeXp,
    xpIntoLevel: into,
    xpForNextLevel: span,
    progressPct: span > 0 ? Math.min(100, Math.round((into / span) * 100)) : 100,
    nextName: next?.name ?? null,
  };
}

/**
 * XP awards. Deliberately flat: a 20-set session earns the same as a 12-set
 * session, because paying per set is exactly how a leaderboard starts pushing
 * people into unsafe volume.
 */
export const XP_AWARDS = {
  workout_completed: 120,
  workout_completed_as_planned: 60,
  class_attended: 100,
  habit_day_complete: 20,
  weekly_checkin: 50,
  personal_record: 80,
  assessment_completed: 60,
  referral_joined: 250,
  challenge_completed: 200,
} as const;

export type XpReason = keyof typeof XP_AWARDS;

export interface XpAward {
  delta: number;
  reason: XpReason;
  refType: string;
  refId: string;
}

/** Daily ceiling. Stops someone farming XP by logging six sessions in a day. */
export const DAILY_XP_CAP = 400;

export function applyDailyCap(awards: XpAward[], alreadyToday: number): XpAward[] {
  let budget = Math.max(0, DAILY_XP_CAP - alreadyToday);
  const out: XpAward[] = [];
  for (const a of awards) {
    if (budget <= 0) break;
    const delta = Math.min(a.delta, budget);
    out.push({ ...a, delta });
    budget -= delta;
  }
  return out;
}

/** Reversing an award is a new negative entry citing the original. */
export function compensate(entry: { id: string; delta: number; reason: string }): {
  delta: number;
  reason: string;
  refType: string;
  refId: string;
  isCorrection: true;
} {
  return {
    delta: -entry.delta,
    reason: `Reversal of ${entry.reason}`,
    refType: 'xp_entry',
    refId: entry.id,
    isCorrection: true,
  };
}

/* ============================================================================
   Streaks
   ========================================================================= */

export interface StreakInput {
  /** Session dates, ISO YYYY-MM-DD, most recent first. */
  sessionDates: string[];
  today: string;
  weeklyTarget: number;
  /** Days the member may miss without breaking the streak. Rest is training. */
  restDaysAllowed: number;
}

export interface StreakResult {
  current: number;
  longest: number;
  lastSessionOn: string | null;
  thisWeek: number;
  week: boolean[];
  atRisk: boolean;
}

export function computeStreak(i: StreakInput): StreakResult {
  const dates = [...new Set(i.sessionDates)].sort().reverse();
  if (dates.length === 0) {
    return { current: 0, longest: 0, lastSessionOn: null, thisWeek: 0, week: [false, false, false, false, false, false, false], atRisk: false };
  }

  const gap = (a: string, b: string) =>
    Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

  const maxGap = i.restDaysAllowed + 1;

  // Current run, counted back from today. A gap larger than the allowance ends it.
  let current = 0;
  if (gap(i.today, dates[0]!) <= maxGap) {
    current = 1;
    for (let n = 1; n < dates.length; n++) {
      if (gap(dates[n - 1]!, dates[n]!) <= maxGap) current++;
      else break;
    }
  }

  let longest = 0;
  let run = 1;
  for (let n = 1; n <= dates.length; n++) {
    if (n < dates.length && gap(dates[n - 1]!, dates[n]!) <= maxGap) run++;
    else {
      longest = Math.max(longest, run);
      run = 1;
    }
  }
  longest = Math.max(longest, current);

  const monday = mondayOf(i.today);
  const week = Array.from({ length: 7 }, (_, d) => dates.includes(addDaysIso(monday, d)));
  const thisWeek = week.filter(Boolean).length;

  return {
    current,
    longest,
    lastSessionOn: dates[0]!,
    thisWeek,
    week,
    atRisk: current > 0 && gap(i.today, dates[0]!) === maxGap,
  };
}

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ============================================================================
   Challenge scoring
   ========================================================================= */

/** Metrics a challenge may rank on. Volume lifted and any body metric are
 *  absent on purpose and must stay absent (PF-GAME-004). */
export const RANKABLE_METRICS = [
  'sessions',
  'consistency',
  'habit_days',
  'class_count',
  'team_sessions',
] as const;

export type RankableMetric = (typeof RANKABLE_METRICS)[number];

export function isRankable(metric: string): metric is RankableMetric {
  return (RANKABLE_METRICS as readonly string[]).includes(metric);
}

/**
 * Late joiners are scored on rate, not raw count, so joining on day 20 is not
 * automatically a loss and joining on day 1 is not automatically a win.
 */
export function fairScore(args: {
  rawCount: number;
  daysParticipated: number;
  daysElapsed: number;
}): number {
  if (args.daysParticipated <= 0 || args.daysElapsed <= 0) return 0;
  const rate = args.rawCount / args.daysParticipated;
  return Math.round(rate * args.daysElapsed * 100) / 100;
}

export function referralIsSuspicious(args: {
  sameDeviceCount: number;
  joinedWithinMinutes: number;
  sharedPaymentInstrument: boolean;
}): { suspicious: boolean; reason: string | null } {
  if (args.sameDeviceCount > 2) {
    return { suspicious: true, reason: 'More than two sign-ups from one device' };
  }
  if (args.sharedPaymentInstrument) {
    return { suspicious: true, reason: 'Shared payment instrument' };
  }
  if (args.joinedWithinMinutes < 5 && args.sameDeviceCount > 1) {
    return { suspicious: true, reason: 'Multiple sign-ups within minutes on one device' };
  }
  return { suspicious: false, reason: null };
}
