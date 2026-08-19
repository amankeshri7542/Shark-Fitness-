/**
 * Retention risk — PF-SUP-003.
 *
 * Explainable by construction: the score is a sum of named contributions and
 * the reasons ship with it. A number nobody can explain is a number staff will
 * not act on, and one that quietly punishes a member for the gym's own closure
 * is worse than none.
 */

export interface RiskInput {
  /** Sessions in the trailing 4 weeks, most recent week first. */
  weeklySessions: [number, number, number, number];
  /** The member's own baseline, from the 8 weeks before that. */
  baselineWeekly: number;
  daysSinceLastVisit: number | null;
  hasFailedPayment: boolean;
  daysUntilExpiry: number | null;
  autoRenew: boolean;
  unansweredCoachMessages: number;
  openComplaints: number;
  /** Weeks in the window where the branch was shut. Excluded from the drop
   *  calculation — a closure is not a member's disengagement. */
  branchClosedWeeks: number;
  /** Members in their first 30 days are scored more gently; a new joiner with
   *  two sessions is normal, not a churn signal. */
  daysSinceJoined: number;
}

export interface RiskReason {
  code: string;
  label: string;
  points: number;
}

export interface RiskResult {
  score: number;
  band: 'low' | 'watch' | 'high';
  reasons: RiskReason[];
  /** What a staff member should actually do next. */
  recommendedAction: string;
  /** Set when the data is too thin or too distorted to score honestly. */
  suppressed: string | null;
}

export function retentionRisk(i: RiskInput): RiskResult {
  const reasons: RiskReason[] = [];

  if (i.daysSinceJoined < 21) {
    return {
      score: 0,
      band: 'low',
      reasons: [],
      recommendedAction: 'Still settling in. Check the onboarding steps are done.',
      suppressed: 'Joined less than three weeks ago — too early to read a trend.',
    };
  }

  const openWeeks = 4 - i.branchClosedWeeks;
  if (openWeeks <= 1) {
    return {
      score: 0,
      band: 'low',
      reasons: [],
      recommendedAction: 'No action. The branch was closed for most of this window.',
      suppressed: 'The branch was closed for most of the last four weeks.',
    };
  }

  const attended = i.weeklySessions.slice(0, openWeeks).reduce((a, b) => a + b, 0);
  const observedWeekly = attended / openWeeks;

  if (i.baselineWeekly >= 1) {
    const drop = 1 - observedWeekly / i.baselineWeekly;
    if (drop >= 0.7) {
      reasons.push({ code: 'attendance_collapse', label: `Attendance down ${Math.round(drop * 100)}% on their own norm`, points: 34 });
    } else if (drop >= 0.4) {
      reasons.push({ code: 'attendance_drop', label: `Attendance down ${Math.round(drop * 100)}% on their own norm`, points: 20 });
    }
  }

  if (i.daysSinceLastVisit !== null) {
    if (i.daysSinceLastVisit >= 21) {
      reasons.push({ code: 'absent_21', label: `Not seen for ${i.daysSinceLastVisit} days`, points: 26 });
    } else if (i.daysSinceLastVisit >= 10) {
      reasons.push({ code: 'absent_10', label: `Not seen for ${i.daysSinceLastVisit} days`, points: 14 });
    }
  }

  if (i.hasFailedPayment) {
    reasons.push({ code: 'payment_failed', label: 'A payment failed and is unresolved', points: 18 });
  }

  if (i.daysUntilExpiry !== null && i.daysUntilExpiry <= 30 && !i.autoRenew) {
    reasons.push({
      code: 'expiring_no_renew',
      // A membership that already lapsed reads "Expired 5 days ago", not
      // "Expires in -5 days". The negative form was invisible until Phase 9
      // put these labels on a screen staff read; the arithmetic was always
      // right and the sentence was always wrong.
      label:
        i.daysUntilExpiry <= 0
          ? `Expired ${Math.abs(i.daysUntilExpiry)} day${Math.abs(i.daysUntilExpiry) === 1 ? '' : 's'} ago with auto-renew off`
          : `Expires in ${i.daysUntilExpiry} day${i.daysUntilExpiry === 1 ? '' : 's'} with auto-renew off`,
      points: i.daysUntilExpiry <= 14 ? 16 : 10,
    });
  }

  if (i.unansweredCoachMessages > 0) {
    reasons.push({ code: 'coach_silence', label: `${i.unansweredCoachMessages} coach message(s) unanswered`, points: 8 });
  }

  if (i.openComplaints > 0) {
    reasons.push({ code: 'open_complaint', label: `${i.openComplaints} open complaint(s)`, points: 12 });
  }

  const score = Math.min(100, reasons.reduce((sum, r) => sum + r.points, 0));
  const band: RiskResult['band'] = score >= 55 ? 'high' : score >= 28 ? 'watch' : 'low';

  return {
    score,
    band,
    reasons,
    recommendedAction: recommendAction(band, reasons),
    suppressed: null,
  };
}

function recommendAction(band: RiskResult['band'], reasons: RiskReason[]): string {
  const codes = new Set(reasons.map((r) => r.code));
  if (codes.has('payment_failed')) {
    return 'Sort the failed payment first. Everything else reads worse than it is until that is cleared.';
  }
  if (codes.has('open_complaint')) {
    return 'Close the open complaint before any renewal conversation.';
  }
  if (band === 'high') {
    return 'A personal call from someone they know, this week. Not an automated message.';
  }
  if (band === 'watch') {
    return 'Have their coach check in. Ask what changed rather than pitching anything.';
  }
  return 'No action needed.';
}

/**
 * Guards on automated outreach — PF-SUP-005. High-pressure sequences are not
 * allowed, and neither is contacting someone who opted out or is inside quiet
 * hours, however urgent the pipeline thinks it is.
 */
export interface OutreachGuardInput {
  optedOut: boolean;
  insideQuietHours: boolean;
  messagesSentLast7d: number;
  hasOpenComplaint: boolean;
  isVulnerabilityFlagged: boolean;
}

export function canSendAutomatedOutreach(i: OutreachGuardInput): { allowed: boolean; reason: string | null } {
  if (i.optedOut) return { allowed: false, reason: 'Member opted out of this channel' };
  if (i.isVulnerabilityFlagged) return { allowed: false, reason: 'Vulnerability flag — human contact only' };
  if (i.hasOpenComplaint) return { allowed: false, reason: 'Open complaint — automation paused' };
  if (i.insideQuietHours) return { allowed: false, reason: 'Inside quiet hours' };
  if (i.messagesSentLast7d >= 3) return { allowed: false, reason: 'Weekly contact limit reached' };
  return { allowed: true, reason: null };
}
