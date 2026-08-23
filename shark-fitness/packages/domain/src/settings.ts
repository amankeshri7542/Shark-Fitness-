import type { BranchState } from '@shark/contracts';

/* ============================================================================
   Tenant and branch configuration — PF-TEN-001…006.

   Everything here is pure. The interesting parts of Settings are not the forms
   but the four questions the forms are allowed to ask:

   - Which lifecycle move is legal, and what does the new state stop?
   - Is this value the tenant's, or has this branch overridden it?
   - What has to be true before a gym can open its doors?
   - What does changing this break that is already recorded?

   That last one runs through the module. A gym's configuration is read by
   invoices, doors and rosters that already happened, so a setting is only safe
   to change when the change is *prospective*. Where it is not, the rule is to
   refuse or to warn — never to quietly rewrite history to match the new
   answer.
   ========================================================================= */

/* ——— Branch lifecycle (PF-TEN-004) ————————————————————————— */

/**
 * What each state means to the rest of the product.
 *
 * `trades` is the one that matters: it gates new bookings, check-ins and
 * sales. Everything already recorded stays exactly where it is in every state,
 * including `archived` — the PRD requires the states "without deleting
 * historical records", so archiving is a door being locked, never a delete.
 */
export interface BranchStateRules {
  /** Accepts new bookings, check-ins and sales. */
  trades: boolean;
  /** Appears in operational branch pickers. Archived branches do not. */
  selectable: boolean;
  /** One line an operator can act on, shown beside the state. */
  meaning: string;
}

export const BRANCH_STATES: Record<BranchState, BranchStateRules> = {
  draft: {
    trades: false,
    selectable: true,
    meaning: 'Being set up. Not open to members and not counted in operations.',
  },
  active: {
    trades: true,
    selectable: true,
    meaning: 'Open and trading.',
  },
  temporarily_closed: {
    trades: false,
    selectable: true,
    meaning: 'Shut for now — refurbishment or a seasonal break. Memberships continue.',
  },
  suspended: {
    trades: false,
    selectable: true,
    meaning: 'Held by the operator or the platform. Nothing new until it is lifted.',
  },
  archived: {
    trades: false,
    selectable: false,
    meaning: 'Permanently closed. Its history stays readable; nothing new is accepted.',
  },
};

/**
 * Which lifecycle moves are legal.
 *
 * `archived` is not a dead end. A gym that closed for a year and reopens is an
 * ordinary thing, and the alternative — making them build a second branch —
 * would split that gym's history in two, which is precisely what PF-TEN-004
 * exists to prevent. Reopening lands in `temporarily_closed` rather than
 * `active` on purpose: somebody has to check the hours, the kit and the roster
 * before members are told the doors are open.
 */
const TRANSITIONS: Record<BranchState, BranchState[]> = {
  draft: ['active', 'archived'],
  active: ['temporarily_closed', 'suspended', 'archived'],
  temporarily_closed: ['active', 'suspended', 'archived'],
  suspended: ['active', 'temporarily_closed', 'archived'],
  archived: ['temporarily_closed'],
};

/** Whether a branch may move from one state to another, and why not. Named
 *  distinctly from the membership machine's outcome: they are different
 *  vocabularies and collapsing them into one type would invite using the wrong
 *  one. */
export interface BranchTransitionOutcome {
  ok: boolean;
  message: string;
}

export function canTransitionBranch(from: BranchState, to: BranchState): BranchTransitionOutcome {
  if (from === to) return { ok: false, message: `This branch is already ${label(to)}.` };
  if (TRANSITIONS[from].includes(to)) return { ok: true, message: '' };
  if (from === 'archived') {
    return {
      ok: false,
      message: 'An archived branch reopens as temporarily closed, so its hours and roster can be checked first.',
    };
  }
  return { ok: false, message: `A branch cannot go from ${label(from)} to ${label(to)}.` };
}

export const label = (state: BranchState): string => state.replace(/_/g, ' ');

/** States a branch may move to from here, for a picker that offers no dead ends. */
export const nextBranchStates = (from: BranchState): BranchState[] => TRANSITIONS[from];

/** Does this branch accept new bookings, check-ins and sales right now? */
export const branchTrades = (state: BranchState): boolean => BRANCH_STATES[state].trades;

/* ——— Tenant defaults and branch overrides (PF-TEN-003) ————————— */

/**
 * The policy keys a branch may override, and the ones only a tenant may set.
 *
 * The split is not arbitrary. A key is branch-overridable when the thing it
 * governs is physically different at each site — door hardware, class demand,
 * a stockroom's discipline, when the neighbours will tolerate a phone buzzing.
 * `graceDays` is not: it is a billing promise made to a member, the dunning job
 * runs tenant-wide, and letting one branch forgive debt three days longer than
 * another is a policy nobody could explain to the member who moved branch.
 */
export const BRANCH_POLICY_KEYS = [
  'graceAllowsEntry',
  'antiPassbackSeconds',
  'holdSeconds',
  'waitlistOfferMinutes',
  'allowNegativeStock',
  'quietHoursFrom',
  'quietHoursTo',
] as const;

export type BranchPolicyKey = (typeof BRANCH_POLICY_KEYS)[number];

export const TENANT_ONLY_POLICY_KEYS = ['graceDays'] as const;

/** A resolved setting and where the answer came from. */
export interface Resolved<T> {
  value: T;
  /** `tenant` when inherited, `branch` when this branch overrides it. */
  source: 'tenant' | 'branch' | 'default';
}

/**
 * Resolve one policy key for a branch.
 *
 * **An absent key is the inheritance indicator.** There is no separate
 * "inherited?" boolean that could drift out of step with the value beside it:
 * a branch either holds an override or it does not, and the console reads the
 * same `source` the door does. Storing `null` to mean "inherit" would have
 * made "explicitly off" and "not set" the same value, which is the bug this
 * shape exists to avoid.
 */
export function resolvePolicy<T>(
  key: string,
  tenantPolicy: Record<string, unknown>,
  branchPolicy: Record<string, unknown> | null | undefined,
  fallback: T,
): Resolved<T> {
  if (branchPolicy && Object.prototype.hasOwnProperty.call(branchPolicy, key)) {
    return { value: branchPolicy[key] as T, source: 'branch' };
  }
  if (Object.prototype.hasOwnProperty.call(tenantPolicy, key)) {
    return { value: tenantPolicy[key] as T, source: 'tenant' };
  }
  return { value: fallback, source: 'default' };
}

/** Reject an override of a key the tenant reserves, before it reaches storage. */
export function assertOverridable(keys: string[]): { ok: boolean; message: string } {
  const reserved = keys.filter((k) => (TENANT_ONLY_POLICY_KEYS as readonly string[]).includes(k));
  if (reserved.length > 0) {
    return {
      ok: false,
      message: `${reserved.join(', ')} is set for the whole gym and cannot differ by branch.`,
    };
  }
  const unknown = keys.filter((k) => !(BRANCH_POLICY_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return { ok: false, message: `Not a branch setting: ${unknown.join(', ')}.` };
  return { ok: true, message: '' };
}

/* ——— Opening hours (PF-TEN-002) ——————————————————————————— */

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export interface DayHours {
  /** Minutes from local midnight. */
  open: number;
  close: number;
  closed: boolean;
}

export type WeekHours = Partial<Record<DayKey, DayHours>>;

/**
 * Validate a week of opening hours.
 *
 * A close before an open is the obvious error. The one worth naming is a gym
 * that trades past midnight: `close` of 1500 on a day that opened at 360 is
 * fine, but 60 is not, because the door reads these as minutes within *one*
 * local day. Rather than silently accepting an overnight range the access
 * decision cannot honour, say so.
 */
export function validateHours(hours: WeekHours): { ok: boolean; message: string } {
  for (const [day, value] of Object.entries(hours) as Array<[string, DayHours]>) {
    if (!(DAY_KEYS as readonly string[]).includes(day)) {
      return { ok: false, message: `${day} is not a day of the week.` };
    }
    if (value.closed) continue;
    if (!Number.isInteger(value.open) || !Number.isInteger(value.close)) {
      return { ok: false, message: `${day} needs whole minutes.` };
    }
    if (value.open < 0 || value.open > 1440 || value.close < 0 || value.close > 1440) {
      return { ok: false, message: `${day} has a time outside the day.` };
    }
    if (value.close <= value.open) {
      return {
        ok: false,
        message: `${day} closes before it opens. A day that runs past midnight has to close at 24:00 and open again the next day.`,
      };
    }
  }
  return { ok: true, message: '' };
}

/** The hours in force on a given weekday: the day's own, or the branch's typical day. */
export function hoursFor(
  hours: WeekHours | null | undefined,
  day: DayKey,
  fallback: { open: number; close: number },
): Resolved<DayHours> {
  const specific = hours?.[day];
  if (specific) return { value: specific, source: 'branch' };
  return { value: { ...fallback, closed: false }, source: 'default' };
}

/* ——— Guided setup (PF-TEN-006) ——————————————————————————— */

/**
 * What the console can observe about a tenant's readiness.
 *
 * Every field is counted from real rows. A checklist with its own stored
 * ticks is a checklist that lies the moment somebody deletes the thing it was
 * ticked for, and "setup complete" over a gym with no products is worse than
 * no checklist at all.
 */
export interface SetupFacts {
  branches: number;
  activeBranches: number;
  branchesWithHours: number;
  rooms: number;
  staff: number;
  products: number;
  hasTaxProfile: boolean;
  hasDataProcessing: boolean;
  members: number;
}

export interface ChecklistItem {
  key: string;
  label: string;
  /** What the operator gets by doing it — never a restatement of the label. */
  why: string;
  done: boolean;
  /** Where to go. A checklist item that cannot be acted on is a nag. */
  to: string;
  /** A step somebody has to do before members arrive. */
  blocking: boolean;
}

export function setupChecklist(facts: SetupFacts): { items: ChecklistItem[]; done: number; total: number } {
  const items: ChecklistItem[] = [
    {
      key: 'branch',
      label: 'Add your first location',
      why: 'Everything else — hours, classes, the door, the till — hangs off a branch.',
      done: facts.branches > 0,
      to: '/settings?tab=branches',
      blocking: true,
    },
    {
      key: 'hours',
      label: 'Set opening hours',
      why: 'The door refuses entry outside them, and classes cannot be scheduled without them.',
      done: facts.branches > 0 && facts.branchesWithHours >= facts.branches,
      to: '/settings?tab=branches',
      blocking: true,
    },
    {
      key: 'tax',
      label: 'Record your tax details',
      why: 'Invoices raised before this is set will not carry a registration number.',
      done: facts.hasTaxProfile,
      to: '/settings?tab=business',
      blocking: true,
    },
    {
      key: 'products',
      label: 'Publish a membership plan',
      why: 'Nobody can join until there is something to join.',
      done: facts.products > 0,
      to: '/plans',
      blocking: true,
    },
    {
      key: 'staff',
      label: 'Invite your team',
      why: 'Reception cannot check anyone in from an account that does not exist.',
      done: facts.staff > 1,
      to: '/staff',
      blocking: true,
    },
    {
      key: 'privacy',
      label: 'Set data-retention and privacy contact',
      why: 'A member asking what you hold on them needs somewhere to write to.',
      done: facts.hasDataProcessing,
      to: '/settings?tab=privacy',
      blocking: false,
    },
    {
      key: 'rooms',
      label: 'Name your rooms and studios',
      why: 'A class timetable reads better when it says where, and room capacity caps bookings.',
      done: facts.rooms > 0,
      to: '/settings?tab=branches',
      blocking: false,
    },
    {
      key: 'open',
      label: 'Open a branch',
      why: 'A draft branch takes no bookings, no check-ins and no sales.',
      done: facts.activeBranches > 0,
      to: '/settings?tab=branches',
      blocking: true,
    },
  ];
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}

/* ——— Changes that reach backwards ————————————————————————— */

/**
 * A consequence of a setting change that the operator has to see first.
 *
 * `blocking` means the change is refused until the cause is dealt with;
 * otherwise it is a warning they acknowledge. The distinction is whether
 * proceeding would leave data unreachable or merely surprising.
 */
export interface Consequence {
  code: string;
  message: string;
  blocking: boolean;
  count?: number;
}

/**
 * What changing a branch's timezone does.
 *
 * Nothing, to the data — every instant is stored as epoch milliseconds and a
 * timezone is a lens, not a value. What it does change is which *local day* a
 * past instant falls in, so a report boundary can move a late-evening sale
 * into the previous day. That is a real surprise and worth stating, but it is
 * presentation, and refusing the change would be wrong: a gym that moves city
 * has to be able to say so.
 */
export function timezoneChangeConsequences(
  from: string,
  to: string,
  futureBookings: number,
): Consequence[] {
  if (from === to) return [];
  const out: Consequence[] = [
    {
      code: 'timezone.presentation_only',
      message: `Times already recorded do not move. They were stored as exact instants and will now be read in ${to} instead of ${from}, so a late-evening entry can appear on the day before or after in reports.`,
      blocking: false,
    },
  ];
  if (futureBookings > 0) {
    out.push({
      code: 'timezone.future_bookings',
      message: `${futureBookings} future ${futureBookings === 1 ? 'booking starts' : 'bookings start'} at the same instant but will now be shown in ${to}. Tell the members whose class appears to have moved.`,
      blocking: false,
      count: futureBookings,
    });
  }
  return out;
}

/**
 * What closing, suspending or archiving a branch does.
 *
 * Future bookings are **not** cancelled here. Cancelling somebody's class is a
 * decision with a refund attached and it belongs to a person, not to a state
 * change — so the count is surfaced and the bookings are left alone.
 *
 * Archiving is refused while members still call the branch home, and that one
 * is blocking rather than advisory: their `homeBranchId` would point at a
 * branch no picker offers, which strands the member rather than merely
 * surprising somebody.
 */
export function branchStateConsequences(
  to: BranchState,
  facts: { futureBookings: number; homeMembers: number; grantedMembers: number; openTickets: number },
): Consequence[] {
  const out: Consequence[] = [];
  if (BRANCH_STATES[to].trades) return out;

  if (facts.futureBookings > 0) {
    out.push({
      code: 'branch.future_bookings',
      message: `${facts.futureBookings} future ${facts.futureBookings === 1 ? 'booking' : 'bookings'} will stay on the timetable. Closing the branch does not cancel them — cancel or move them yourself so members are told.`,
      blocking: false,
      count: facts.futureBookings,
    });
  }

  if (to === 'archived') {
    if (facts.homeMembers > 0) {
      out.push({
        code: 'branch.home_members',
        message: `${facts.homeMembers} ${facts.homeMembers === 1 ? 'member calls' : 'members call'} this their home branch. Move them first — archiving would leave them attached to a branch no longer offered anywhere.`,
        blocking: true,
        count: facts.homeMembers,
      });
    }
    if (facts.grantedMembers > 0) {
      out.push({
        code: 'branch.cross_branch_entitlement',
        message: `${facts.grantedMembers} ${facts.grantedMembers === 1 ? 'member has' : 'members have'} cross-branch access here. Their entitlement is kept exactly as it is — it simply stops opening this door.`,
        blocking: false,
        count: facts.grantedMembers,
      });
    }
    if (facts.openTickets > 0) {
      out.push({
        code: 'branch.open_tickets',
        message: `${facts.openTickets} open support ${facts.openTickets === 1 ? 'ticket names' : 'tickets name'} this branch. They stay open and readable.`,
        blocking: false,
        count: facts.openTickets,
      });
    }
  }
  return out;
}

/**
 * What changing the tenant's currency does.
 *
 * Nothing to any invoice already raised: each one stores the currency it was
 * raised in, and re-reading a rupee invoice as dirhams would change what a
 * customer owes without anybody deciding to. The change applies to what is
 * raised next, and the range spanning both currencies simply has no single
 * total — which the revenue report already knows how to say.
 */
export function currencyChangeConsequences(from: string, to: string, invoices: number): Consequence[] {
  if (from === to) return [];
  const out: Consequence[] = [
    {
      code: 'currency.prospective_only',
      message: `Only what you raise from now on is in ${to}. Nothing already invoiced is re-priced or re-read.`,
      blocking: false,
    },
  ];
  if (invoices > 0) {
    out.push({
      code: 'currency.mixed_history',
      message: `${invoices} existing ${invoices === 1 ? 'invoice stays' : 'invoices stay'} in ${from}. A report covering both will show each currency separately rather than one total, because there is no honest way to add them.`,
      blocking: false,
      count: invoices,
    });
  }
  out.push({
    code: 'currency.reprice_products',
    message: `Plan prices keep their numbers and change denomination. Check the catalogue before the next sale — 2,500 was ${from}, it is now ${to}.`,
    blocking: false,
  });
  return out;
}
