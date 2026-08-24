/* ============================================================================
   Automations — PF-COMM-003…006.

   The rules that decide whether a member hears from the gym, written pure so
   they can be argued with in a test rather than in production at 06:00.

   The module is organised around one asymmetry: **sending is the exception,
   not the default**. Every path here is a reason not to send — no consent,
   quiet hours, already sent, quota exhausted, a variable the template needs
   and the data does not have — and a send happens only when none of them
   applies. An automation that fires when it should not is a member who
   unsubscribes; an automation that stays quiet is a follow-up somebody makes
   by hand.
   ========================================================================= */

/* ——— Templates (PF-COMM-003) ————————————————————————————— */

const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

export interface RenderResult {
  text: string;
  /** Variables the template asks for that the data did not supply. */
  missing: string[];
  /** Variables the template asks for that this trigger never provides. */
  unknown: string[];
}

/**
 * Fill a template, and say what it could not fill.
 *
 * A missing variable is **never** rendered as an empty string or left as
 * `{{endsOn}}`. "Your membership ends on ." is worse than no message, and a
 * member who receives raw template syntax has been told the gym does not check
 * what it sends. The caller decides — the service refuses the send and records
 * the reason — but the decision needs this list to be made at all.
 */
export function renderTemplate(
  body: string,
  values: Record<string, string | number | null | undefined>,
  available?: readonly string[],
): RenderResult {
  const missing: string[] = [];
  const unknown: string[] = [];

  const text = body.replace(TOKEN, (_match, name: string) => {
    if (available && !available.includes(name)) {
      unknown.push(name);
      return `{{${name}}}`;
    }
    const value = values[name];
    if (value === null || value === undefined || value === '') {
      missing.push(name);
      return `{{${name}}}`;
    }
    return String(value);
  });

  return { text, missing: [...new Set(missing)], unknown: [...new Set(unknown)] };
}

/** Every variable a template refers to, in the order it first appears. */
export function templateVariables(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(TOKEN)) {
    const name = match[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/* ——— Triggers (PF-COMM-004) ————————————————————————————— */

export interface TriggerSpec {
  key: string;
  label: string;
  /** What an operator gets by using it, in their words. */
  description: string;
  /** Variables a template on this trigger may use. */
  variables: readonly string[];
  /** Fields a condition on this trigger may test. */
  fields: readonly string[];
  /**
   * How often the same subject can legitimately re-enter.
   *
   * `once_ever` is a welcome; `per_day` is a class reminder. The window is
   * what makes the dedupe key, so this is not documentation — it decides
   * whether a second send is a duplicate or a new event.
   */
  window: 'once_ever' | 'per_day' | 'per_occurrence';
}

const MEMBER_VARS = ['firstName', 'lastName', 'memberNo', 'branchName', 'gymName'] as const;

export const TRIGGERS: readonly TriggerSpec[] = [
  {
    key: 'membership.expiring',
    label: 'Membership about to expire',
    description: 'Runs daily for members whose plan ends within the number of days you choose.',
    variables: [...MEMBER_VARS, 'endsOn', 'daysLeft', 'productName'],
    fields: ['daysLeft', 'productName', 'branchId', 'autoRenew'],
    window: 'per_day',
  },
  {
    key: 'membership.payment_failed',
    label: 'Payment failed',
    description: 'Runs when a payment is refused and the member enters the grace period.',
    variables: [...MEMBER_VARS, 'amountDue', 'graceEndsOn', 'invoiceNumber'],
    fields: ['amountDue', 'branchId'],
    window: 'per_occurrence',
  },
  {
    key: 'member.joined',
    label: 'New member joined',
    description: 'Runs once when somebody joins. A welcome, not a campaign.',
    variables: [...MEMBER_VARS, 'joinedOn', 'productName'],
    fields: ['productName', 'branchId'],
    window: 'once_ever',
  },
  {
    key: 'member.inactive',
    label: 'Member has stopped coming',
    description: 'Runs daily for members whose last visit is further back than you choose.',
    variables: [...MEMBER_VARS, 'daysSinceVisit', 'lastVisitOn'],
    fields: ['daysSinceVisit', 'branchId'],
    window: 'per_day',
  },
  {
    key: 'class.tomorrow',
    label: 'Class tomorrow',
    description: 'Runs the day before, for members booked onto a class.',
    variables: [...MEMBER_VARS, 'className', 'startsAt', 'trainerName', 'roomName'],
    fields: ['className', 'branchId'],
    window: 'per_occurrence',
  },
];

export const triggerSpec = (key: string): TriggerSpec | undefined => TRIGGERS.find((t) => t.key === key);

/* ——— Conditions ————————————————————————————————————————— */

export type ConditionOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains';

export interface Condition {
  field: string;
  op: string;
  value: string;
}

export interface ConditionOutcome {
  ok: boolean;
  message: string;
}

/** A condition an operator wrote against a field the trigger does not have is
 *  a rule that silently never matches. Refuse it when it is written. */
export function validateConditions(trigger: string, conditions: Condition[]): ConditionOutcome {
  const spec = triggerSpec(trigger);
  if (!spec) return { ok: false, message: `${trigger} is not a trigger.` };
  for (const condition of conditions) {
    if (!spec.fields.includes(condition.field)) {
      return {
        ok: false,
        message: `"${spec.label}" has nothing called ${condition.field}. It offers ${spec.fields.join(', ')}.`,
      };
    }
    if (!['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains'].includes(condition.op)) {
      return { ok: false, message: `${condition.op} is not a comparison.` };
    }
  }
  return { ok: true, message: '' };
}

/**
 * Does this subject match?
 *
 * All conditions, never any — an operator adding a second condition is
 * narrowing, and a rule that widens when you add a restriction is one nobody
 * can reason about. An empty list matches everyone, which is what "no
 * conditions" means.
 */
export function matches(conditions: Condition[], facts: Record<string, unknown>): boolean {
  return conditions.every((condition) => {
    const actual = facts[condition.field];
    const expected = condition.value;
    if (actual === null || actual === undefined) return false;

    const numeric = Number(expected);
    const bothNumeric = typeof actual === 'number' && !Number.isNaN(numeric);

    switch (condition.op) {
      case 'eq':
        return String(actual) === expected;
      case 'neq':
        return String(actual) !== expected;
      case 'contains':
        return String(actual).toLowerCase().includes(expected.toLowerCase());
      case 'lt':
        return bothNumeric && actual < numeric;
      case 'lte':
        return bothNumeric && actual <= numeric;
      case 'gt':
        return bothNumeric && actual > numeric;
      case 'gte':
        return bothNumeric && actual >= numeric;
      default:
        return false;
    }
  });
}

/* ——— Quiet hours ————————————————————————————————————————— */

const minutesOf = (clock: string): number => {
  const [h, m] = clock.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Is this local minute inside quiet hours?
 *
 * The window wraps: 21:00 to 08:00 is the normal shape and spans midnight, so
 * a naive `from <= now && now < to` is false all night — which is precisely
 * when it needs to be true. The minute is the **branch's**, because a chain
 * with a gym in Dubai and a gym in Bengaluru does not have one evening.
 */
export function inQuietHours(from: string, to: string, localMinutes: number): boolean {
  const start = minutesOf(from);
  const end = minutesOf(to);
  if (start === end) return false;
  return start < end ? localMinutes >= start && localMinutes < end : localMinutes >= start || localMinutes < end;
}

/* ——— Deduplication (PF-COMM-004) ————————————————————————— */

/**
 * The logical event a run answers.
 *
 * Two runs sharing a key are the same event and the second must not send. The
 * window comes from the trigger: a welcome is once ever, an expiry nudge is
 * once a day, a class reminder is once per class. Getting this wrong in either
 * direction is visible to the member — too narrow and they are messaged twice,
 * too wide and they never hear about the second class.
 */
export function dedupeKey(
  trigger: string,
  subjectId: string,
  context: { day?: string; occurrenceId?: string },
): string {
  const spec = triggerSpec(trigger);
  switch (spec?.window) {
    case 'once_ever':
      return `${trigger}:${subjectId}`;
    case 'per_occurrence':
      return `${trigger}:${subjectId}:${context.occurrenceId ?? context.day ?? ''}`;
    case 'per_day':
    default:
      return `${trigger}:${subjectId}:${context.day ?? ''}`;
  }
}

/* ——— The send decision ————————————————————————————————— */

export type SuppressionCode =
  | 'no_consent'
  | 'quiet_hours'
  | 'already_sent'
  | 'quota_exhausted'
  | 'missing_variables'
  | 'unknown_variables'
  | 'branch_not_trading'
  | 'no_destination'
  | 'account_unavailable'
  | 'provider_unavailable'
  | 'automation_paused';

export interface SendDecision {
  send: boolean;
  code: SuppressionCode | null;
  /** Written for the operator reading the run log, not for a developer. */
  reason: string;
}

export interface SendFacts {
  automationState: string;
  channel: string;
  hasConsent: boolean;
  hasDestination: boolean;
  /** False when the destination belongs to an invited, suspended or deleted
   * account that cannot currently receive an application message. */
  accountActive?: boolean;
  /** False when this deployment has no real adapter for the chosen channel.
   * An unavailable provider is a suppression, never a pretend delivery. */
  providerAvailable?: boolean;
  branchTrades: boolean;
  inQuietHours: boolean;
  alreadySent: boolean;
  quotaRemaining: number | null;
  missingVariables: string[];
  unknownVariables: string[];
}

const SEND = { send: true, code: null, reason: '' } as const;

/**
 * Whether to send, and if not, why not — in that order of checking.
 *
 * The order is the design. Cheapest and most absolute first: a paused
 * automation and a member who withdrew consent are settled facts, and running
 * a template render for them wastes work and, worse, produces a "missing
 * variable" reason for somebody who was never going to be messaged. The reader
 * of the run log gets the *real* reason rather than the first one a naive
 * order happened to hit.
 */
export function decideSend(facts: SendFacts): SendDecision {
  if (facts.automationState !== 'active') {
    return { send: false, code: 'automation_paused', reason: 'The automation is not running.' };
  }
  if (!facts.hasConsent) {
    return { send: false, code: 'no_consent', reason: `This member has not agreed to ${facts.channel} messages.` };
  }
  if (!facts.hasDestination) {
    return { send: false, code: 'no_destination', reason: `No ${facts.channel} address on this member's record.` };
  }
  if (facts.accountActive === false) {
    return {
      send: false,
      code: 'account_unavailable',
      reason: 'The member account is not active, so it cannot receive this message.',
    };
  }
  if (!facts.branchTrades) {
    return { send: false, code: 'branch_not_trading', reason: 'Their branch is closed or archived.' };
  }
  if (facts.alreadySent) {
    return { send: false, code: 'already_sent', reason: 'Already sent for this event.' };
  }
  if (facts.unknownVariables.length > 0) {
    return {
      send: false,
      code: 'unknown_variables',
      reason: `The template uses ${facts.unknownVariables.join(', ')}, which this trigger does not provide.`,
    };
  }
  if (facts.missingVariables.length > 0) {
    return {
      send: false,
      code: 'missing_variables',
      reason: `No value for ${facts.missingVariables.join(', ')} on this member.`,
    };
  }
  if (facts.providerAvailable === false) {
    return {
      send: false,
      code: 'provider_unavailable',
      reason: `No ${facts.channel} delivery provider is configured. Nothing was sent.`,
    };
  }
  if (facts.inQuietHours) {
    return { send: false, code: 'quiet_hours', reason: 'Held until quiet hours end at this branch.' };
  }
  if (facts.quotaRemaining !== null && facts.quotaRemaining <= 0) {
    return { send: false, code: 'quota_exhausted', reason: `This gym's ${facts.channel} allowance is used up.` };
  }
  return SEND;
}

/* ——— Cost (PF-COMM-006) ————————————————————————————————— */

/** Metered channels and what one message costs, in minor units. Nothing is
 *  charged for in-app or push: they cost the platform nothing per message. */
const UNIT_COST_MINOR: Record<string, number> = { sms: 25, whatsapp: 40, email: 0, in_app: 0, push: 0 };

export const estimateCostMinor = (channel: string, recipients: number): number =>
  (UNIT_COST_MINOR[channel] ?? 0) * recipients;

export const isMetered = (channel: string): boolean => (UNIT_COST_MINOR[channel] ?? 0) > 0;
