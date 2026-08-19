/**
 * Support desk rules — PF-SUP-001, PF-SUP-004, PF-SUP-006.
 *
 * Pure. Nothing here reads a clock, a database or a timezone; the caller
 * resolves those and passes the answers in. That is what makes the awkward
 * parts — a promise made across a closing time, a reopened dispute, an
 * intervention whose effect can only be read months later — testable at all.
 */

/* ============================================================================
   SLA
   ========================================================================= */

/** The states a support desk is actually judged in. */
export type SlaState = 'on_track' | 'due_soon' | 'breached' | 'met' | 'none';

export interface BusinessHours {
  /** Minutes past local midnight the branch opens and closes. */
  opensMinutes: number;
  closesMinutes: number;
}

export interface SlaDeadlineInput {
  openedAt: number;
  /** The promise, in minutes of *open* time. */
  responseMinutes: number;
  hours: BusinessHours;
  /** Minutes past local midnight for an instant, in the branch's zone. */
  localMinutesAt: (ms: number) => number;
  /** True when the branch is shut all day — a holiday or a closure. */
  closedOn: (ms: number) => boolean;
}

const MINUTE = 60_000;
const STEP_MINUTES = 5;
/** A fortnight of stepping. A promise that cannot be met inside that is a
 *  configuration error, not a deadline, and is reported as one. */
const MAX_STEPS = (14 * 24 * 60) / STEP_MINUTES;

/**
 * When a reply is due, counting only the hours the desk is open.
 *
 * A four-hour promise made at 22:40 does not fall due at 02:40. Nobody is
 * there, nobody could have answered, and a queue sorted by a deadline computed
 * that way puts every overnight ticket at the top every morning — which is the
 * same as having no priority order at all. So the clock runs while the branch
 * is open and pauses when it shuts, and the deadline lands at the moment the
 * desk has actually had the time it promised.
 *
 * A branch open around the clock (`opensMinutes === closesMinutes`, or a full
 * 0–1440 span) simply never pauses, so this degrades to wall-clock without a
 * special case.
 *
 * Returns `null` when the promise cannot be met inside the step budget — which
 * a caller should surface rather than quietly store a deadline two months out.
 */
export function slaDeadline(input: SlaDeadlineInput): number | null {
  const { openedAt, responseMinutes, hours, localMinutesAt, closedOn } = input;
  if (responseMinutes <= 0) return openedAt;

  const alwaysOpen =
    hours.opensMinutes === hours.closesMinutes || (hours.opensMinutes <= 0 && hours.closesMinutes >= 1440);
  if (alwaysOpen) return openedAt + responseMinutes * MINUTE;

  const isOpen = (ms: number): boolean => {
    if (closedOn(ms)) return false;
    const local = localMinutesAt(ms);
    // A branch whose closing time is "past midnight" (22:00–02:00) is open
    // across the wrap rather than for minus twenty hours.
    return hours.closesMinutes > hours.opensMinutes
      ? local >= hours.opensMinutes && local < hours.closesMinutes
      : local >= hours.opensMinutes || local < hours.closesMinutes;
  };

  let remaining = responseMinutes;
  let cursor = openedAt;
  for (let step = 0; step < MAX_STEPS && remaining > 0; step += 1) {
    if (isOpen(cursor)) remaining -= STEP_MINUTES;
    cursor += STEP_MINUTES * MINUTE;
  }
  return remaining > 0 ? null : cursor;
}

export interface SlaStateInput {
  /** Terminal tickets are judged on what happened, not on the clock. */
  state: string;
  slaDueAt: number | null;
  /** When a human first replied. Once set, the verdict is fixed for ever. */
  firstResponseAt: number | null;
  now: number;
  /** How close to the deadline counts as "due soon". */
  dueSoonMinutes?: number;
}

export interface SlaView {
  state: SlaState;
  label: string;
  /** Negative once past the deadline. Null when there is nothing to count. */
  dueInMinutes: number | null;
  breached: boolean;
}

/**
 * The SLA verdict, computed — never stored.
 *
 * Two things make this worth stating carefully. First, the clock stops at the
 * *first reply*, not at resolution: a desk that answers in ten minutes and then
 * spends a week fixing a boiler has met its promise, and a system that says
 * otherwise will be ignored within a month. Second, once a first reply exists
 * the verdict never changes again, because whether it was late is a fact about
 * the past. A stored boolean would drift the moment either rule moved.
 */
export function slaView(input: SlaStateInput): SlaView {
  const { state, slaDueAt, firstResponseAt, now, dueSoonMinutes = 60 } = input;

  if (slaDueAt === null) {
    return { state: 'none', label: 'No reply time promised', dueInMinutes: null, breached: false };
  }

  if (firstResponseAt !== null) {
    const lateBy = Math.round((firstResponseAt - slaDueAt) / MINUTE);
    return lateBy > 0
      ? { state: 'breached', label: `First reply ${humanise(lateBy)} late`, dueInMinutes: -lateBy, breached: true }
      : { state: 'met', label: `Answered with ${humanise(-lateBy)} to spare`, dueInMinutes: -lateBy, breached: false };
  }

  // Never answered and already closed: the promise was missed whatever the
  // outcome. Quietly resolving a ticket must not launder a breach.
  if (state === 'resolved' || state === 'closed') {
    const lateBy = Math.round((now - slaDueAt) / MINUTE);
    return lateBy > 0
      ? { state: 'breached', label: 'Closed without a reply, past the promise', dueInMinutes: -lateBy, breached: true }
      : { state: 'met', label: 'Closed inside the promise', dueInMinutes: -lateBy, breached: false };
  }

  const dueIn = Math.round((slaDueAt - now) / MINUTE);
  if (dueIn < 0) {
    return { state: 'breached', label: `Reply ${humanise(-dueIn)} overdue`, dueInMinutes: dueIn, breached: true };
  }
  if (dueIn <= dueSoonMinutes) {
    return { state: 'due_soon', label: `Reply due in ${humanise(dueIn)}`, dueInMinutes: dueIn, breached: false };
  }
  return { state: 'on_track', label: `Reply due in ${humanise(dueIn)}`, dueInMinutes: dueIn, breached: false };
}

function humanise(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))} days`;
}

/* ============================================================================
   Ticket lifecycle — PF-SUP-001, PF-SUP-006
   ========================================================================= */

/** The states `@shark/contracts` has carried since Phase 1. */
export type TicketState = 'open' | 'pending_member' | 'pending_staff' | 'resolved' | 'closed';

const STATE_LABEL: Record<TicketState, string> = {
  open: 'open',
  pending_member: 'waiting on the member',
  pending_staff: 'waiting on us',
  resolved: 'resolved',
  closed: 'closed',
};

/**
 * Which transitions exist at all.
 *
 * The two pending states are kept apart because they mean opposite things to a
 * queue: `pending_member` is somebody else's turn and should stop pulling the
 * desk's attention, while `pending_staff` is work sitting in the building. A
 * single "pending" would merge the ticket nobody owes anything on with the one
 * being ignored.
 *
 * `closed` is terminal on purpose. A resolved ticket can still come back —
 * disputes do — and reopening keeps the same reference and the same immutable
 * timeline, because it is the same argument. Closing is the deliberate act that
 * ends it, and a member who returns after that starts a new ticket that can be
 * linked, rather than a silent rewrite of a settled record.
 */
const TRANSITIONS: Record<TicketState, TicketState[]> = {
  open: ['pending_member', 'pending_staff', 'resolved', 'closed'],
  pending_member: ['open', 'pending_staff', 'resolved', 'closed'],
  pending_staff: ['open', 'pending_member', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
};

/** Named for tickets: `canTransition` already means memberships elsewhere. */
export function canTransitionTicket(from: TicketState, to: TicketState): boolean {
  if (from === to) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function transitionRefusal(from: TicketState, to: TicketState): string | null {
  if (canTransitionTicket(from, to)) return null;
  if (from === to) return `This ticket is already ${STATE_LABEL[from] ?? from}.`;
  if (from === 'closed') {
    return 'A closed ticket is a settled record and cannot be moved. Open a new ticket and reference this one.';
  }
  return `A ticket that is ${STATE_LABEL[from] ?? from} cannot go straight to ${STATE_LABEL[to] ?? to}.`;
}

/* ============================================================================
   Intervention effectiveness — PF-SUP-004
   ========================================================================= */

export interface InterventionOutcomeRow {
  action: string;
  outcome: string | null;
  riskBandAtCreation: string;
}

export interface EffectivenessRow {
  action: string;
  attempted: number;
  /** Reached and still a member. */
  retained: number;
  churned: number;
  /** Never got hold of them — excluded from the rate, not counted as failure. */
  noContact: number;
  /** Staff said the score was wrong. Excluded from the rate too, and reported
   *  separately because a rising count is a signal about the model. */
  falsePositive: number;
  /** Null until there is enough to divide by. A rate over two cases is noise
   *  dressed as measurement (PF-RPT-004: label model-derived values). */
  retentionRate: number | null;
  pending: number;
}

const MIN_FOR_A_RATE = 3;

/**
 * How well each intervention actually worked.
 *
 * `no_contact` and `false_positive` are removed from the denominator rather
 * than counted as failures. A call nobody answered says nothing about whether
 * calling works, and a member staff judged never to have been at risk was never
 * a test of the intervention — including either would make the least-used
 * action look the most effective.
 */
export function interventionEffectiveness(rows: InterventionOutcomeRow[]): EffectivenessRow[] {
  const byAction = new Map<string, EffectivenessRow>();

  for (const row of rows) {
    const entry = byAction.get(row.action) ?? {
      action: row.action,
      attempted: 0,
      retained: 0,
      churned: 0,
      noContact: 0,
      falsePositive: 0,
      retentionRate: null,
      pending: 0,
    };
    entry.attempted += 1;
    if (row.outcome === 'retained') entry.retained += 1;
    else if (row.outcome === 'churned') entry.churned += 1;
    else if (row.outcome === 'no_contact') entry.noContact += 1;
    else if (row.outcome === 'false_positive') entry.falsePositive += 1;
    else entry.pending += 1;
    byAction.set(row.action, entry);
  }

  return [...byAction.values()]
    .map((entry) => {
      const judged = entry.retained + entry.churned;
      return {
        ...entry,
        retentionRate: judged >= MIN_FOR_A_RATE ? Math.round((entry.retained / judged) * 100) : null,
      };
    })
    .sort((a, b) => b.attempted - a.attempted);
}

/* ============================================================================
   Feedback aggregation — PF-SUP-002
   ========================================================================= */

export interface NpsSummary {
  responses: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** −100…100. Null under the reporting floor. */
  score: number | null;
}

const MIN_FOR_NPS = 5;

/**
 * Net Promoter Score, by its actual definition: promoters minus detractors as
 * a percentage of responses — not an average of the 0–10 answers, which is a
 * different and much flatter number that people quote as NPS constantly.
 *
 * Withheld under five responses. An NPS of −100 from one grumpy answer is
 * arithmetically true and completely useless, and printing it invites a
 * decision nobody should make.
 */
export function npsSummary(scores: number[]): NpsSummary {
  const valid = scores.filter((s) => Number.isInteger(s) && s >= 0 && s <= 10);
  const promoters = valid.filter((s) => s >= 9).length;
  const passives = valid.filter((s) => s >= 7 && s <= 8).length;
  const detractors = valid.filter((s) => s <= 6).length;
  return {
    responses: valid.length,
    promoters,
    passives,
    detractors,
    score:
      valid.length >= MIN_FOR_NPS
        ? Math.round(((promoters - detractors) / valid.length) * 100)
        : null,
  };
}

export interface CsatSummary {
  responses: number;
  /** Mean of the 1–5 answers, to one decimal. Null under the floor. */
  average: number | null;
  /** Percentage answering 4 or 5. Null under the floor. */
  satisfiedPct: number | null;
}

export function csatSummary(scores: number[]): CsatSummary {
  const valid = scores.filter((s) => Number.isInteger(s) && s >= 1 && s <= 5);
  if (valid.length < MIN_FOR_NPS) {
    return { responses: valid.length, average: null, satisfiedPct: null };
  }
  const sum = valid.reduce((a, b) => a + b, 0);
  return {
    responses: valid.length,
    average: Math.round((sum / valid.length) * 10) / 10,
    satisfiedPct: Math.round((valid.filter((s) => s >= 4).length / valid.length) * 100),
  };
}
