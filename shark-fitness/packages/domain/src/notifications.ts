/**
 * Notification rules (PF-COMM-002, PF-COMM-005, PF-COMM-006; PRD 04 consent).
 *
 * Pure decisions the API's NotificationService applies at enqueue *and again
 * at send time*. Nothing here talks to a provider.
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'email', 'sms', 'whatsapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Why a message is being sent, which decides whose permission it needs.
 *
 * - **transactional** — receipts, payment problems, security. Part of the
 *   contract; no opt-out, but still needs a destination.
 * - **operational** — booking changes, class reminders, desk replies. On by
 *   default; a member can switch them off.
 * - **coaching** — check-in feedback, habit nudges, coach messages. On by
 *   default; off when the member opts out (or opted out of the module).
 * - **promotional** — offers, news, campaigns. Off until the member said yes
 *   on that channel. Absence is refusal.
 */
export const NOTIFICATION_PURPOSES = ['transactional', 'operational', 'coaching', 'promotional'] as const;
export type NotificationPurpose = (typeof NOTIFICATION_PURPOSES)[number];

/** The consent row each purpose/channel pair reads. Null = no consent needed. */
export function consentPurposeFor(purpose: NotificationPurpose, channel: NotificationChannel): {
  key: string | null;
  /** What absence means: `true` = on unless withdrawn, `false` = off until granted. */
  defaultGranted: boolean;
} {
  if (purpose === 'transactional') return { key: null, defaultGranted: true };
  if (purpose === 'operational') return { key: 'notifications_operational', defaultGranted: true };
  if (purpose === 'coaching') return { key: 'notifications_coaching', defaultGranted: true };
  // Promotional: the product's own surfaces need no marketing consent, the
  // metered channels each need their own explicit yes.
  if (channel === 'in_app' || channel === 'push') return { key: null, defaultGranted: true };
  return { key: `marketing_${channel}`, defaultGranted: false };
}

export interface ConsentDecision {
  allowed: boolean;
  /** Stable code for counting exclusions. */
  code: 'ok' | 'no_consent' | 'opted_out';
  reason: string;
}

/**
 * Does the member's recorded consent allow this message?
 * `consents` maps a consent purpose to its stored value; a missing key means
 * the member never answered.
 */
export function consentAllows(
  purpose: NotificationPurpose,
  channel: NotificationChannel,
  consents: Record<string, boolean | undefined>,
): ConsentDecision {
  const { key, defaultGranted } = consentPurposeFor(purpose, channel);
  if (!key) return { allowed: true, code: 'ok', reason: '' };
  const stored = consents[key];
  if (stored === undefined) {
    return defaultGranted
      ? { allowed: true, code: 'ok', reason: '' }
      : { allowed: false, code: 'no_consent', reason: `They have not agreed to ${channelLabel(channel)} offers.` };
  }
  if (stored) return { allowed: true, code: 'ok', reason: '' };
  return defaultGranted
    ? { allowed: false, code: 'opted_out', reason: `They switched off ${purpose} messages.` }
    : { allowed: false, code: 'opted_out', reason: `They withdrew consent for ${channelLabel(channel)} offers.` };
}

/** Quiet hours defer interruptions. In-app is an inbox, not an interruption,
 *  and a transactional message (a payment failed, a code) is not held. */
export function quietHoursApply(purpose: NotificationPurpose, channel: NotificationChannel): boolean {
  return channel !== 'in_app' && purpose !== 'transactional';
}

/** Minutes past midnight inside a `from`–`to` window that may wrap midnight. */
export function insideWindow(fromMinutes: number, toMinutes: number, minutes: number): boolean {
  if (fromMinutes === toMinutes) return false;
  return fromMinutes < toMinutes
    ? minutes >= fromMinutes && minutes < toMinutes
    : minutes >= fromMinutes || minutes < toMinutes;
}

/** What to do after a provider answered with `status` (0 = network/timeout). */
export function classifyProviderResponse(status: number): 'accepted' | 'retry' | 'permanent' {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 0 || status === 408 || status === 429 || status >= 500) return 'retry';
  return 'permanent';
}

/** Attempts before a retryable failure becomes final. */
export const MAX_NOTIFICATION_ATTEMPTS = 3;

/** Backoff after attempt `n` (1-based) failed retryably: 1 min, then 5 min. */
export function notificationRetryDelayMs(attempt: number): number {
  return attempt <= 1 ? 60_000 : 5 * 60_000;
}

/** "+91•••••45678", "a•••@gmail.com" — enough for staff to recognise, not to copy. */
export function maskDestination(channel: NotificationChannel, address: string): string {
  if (channel === 'email') {
    const [local = '', domain = ''] = address.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  if (channel === 'sms' || channel === 'whatsapp') {
    return address.length <= 5 ? '•••' : `${address.slice(0, 3)}•••••${address.slice(-5)}`;
  }
  return channel === 'push' ? 'this device' : 'in the app';
}

export function channelLabel(channel: NotificationChannel | string): string {
  switch (channel) {
    case 'in_app':
      return 'in-app';
    case 'push':
      return 'push';
    case 'email':
      return 'email';
    case 'sms':
      return 'SMS';
    case 'whatsapp':
      return 'WhatsApp';
    default:
      return channel;
  }
}

/* ——— Broadcast cost (PF-COMM-006) ——————————————————————————— */

/** Paise per message. A gym overrides any of these in Settings (`messagingRates`). */
export const DEFAULT_MESSAGE_RATES_MINOR: Record<NotificationChannel, number> = {
  in_app: 0,
  push: 0,
  email: 10,
  sms: 25,
  whatsapp: 80,
};

export function messageRates(overrides: unknown): Record<NotificationChannel, number> {
  const out = { ...DEFAULT_MESSAGE_RATES_MINOR };
  if (overrides && typeof overrides === 'object') {
    for (const channel of NOTIFICATION_CHANNELS) {
      const value = (overrides as Record<string, unknown>)[channel];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[channel] = value;
    }
  }
  return out;
}

/** Recipients × rate, in integer minor units. */
export function broadcastCostMinor(recipients: number, ratePerMessageMinor: number): number {
  return Math.max(0, recipients) * Math.max(0, ratePerMessageMinor);
}

/* ——— Minors (PRD 04 ENT-CHILD-001/003; plan decision 16) —————————— */

/** Whole years between an ISO date of birth and an ISO day. Null when unknown. */
export function ageOn(dob: string | null | undefined, isoDay: string): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}/.test(dob)) return null;
  const [by, bm, bd] = dob.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = isoDay.slice(0, 10).split('-').map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

/** Under 18 on that day. An unknown date of birth is treated as an adult —
 *  the gym records DOB at enrolment for exactly this reason. */
export function isMinor(dob: string | null | undefined, isoDay: string): boolean {
  const age = ageOn(dob, isoDay);
  return age !== null && age < 18;
}

/* ——— Coach habit templates (PF-NUTR-002) ———————————————————— */

export interface HabitTemplate {
  key: string;
  name: string;
  target: number;
  unit: string;
  cadence: 'daily' | 'weekly';
  icon: string;
  /** One line a coach reads before assigning it. */
  why: string;
}

export const HABIT_TEMPLATES: HabitTemplate[] = [
  { key: 'water', name: 'Drink water', target: 3, unit: 'litres', cadence: 'daily', icon: 'drop', why: 'Most people under-drink on training days.' },
  { key: 'sleep', name: 'Sleep 7 hours', target: 7, unit: 'hours', cadence: 'daily', icon: 'moon', why: 'Recovery and appetite both follow sleep.' },
  { key: 'steps', name: 'Walk 8,000 steps', target: 8000, unit: 'steps', cadence: 'daily', icon: 'steps', why: 'Daily movement outside the gym.' },
  { key: 'protein', name: 'Protein with every meal', target: 3, unit: 'meals', cadence: 'daily', icon: 'plate', why: 'A simple anchor without counting grams.' },
  { key: 'mobility', name: 'Mobility 10 minutes', target: 10, unit: 'minutes', cadence: 'daily', icon: 'stretch', why: 'Keeps sore joints moving between sessions.' },
  { key: 'vegetables', name: 'Two portions of vegetables', target: 2, unit: 'portions', cadence: 'daily', icon: 'leaf', why: 'Fibre and fullness, no restriction.' },
];
