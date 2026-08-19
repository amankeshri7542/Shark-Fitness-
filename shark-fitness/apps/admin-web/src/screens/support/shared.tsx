import type { ReactNode } from 'react';
import type { SlaState, TicketPriority, TicketState } from '@shark/contracts';
import { Chip, type Tone } from '../../ui/console';

/* ============================================================================
   Support shared pieces.

   Support is a plain-register surface (`PLAIN_ONLY_SURFACES` in `tone.ts`).
   Nothing in this module reaches for the training floor's predator voice: a
   person writing to a support desk is usually annoyed, sometimes frightened,
   and occasionally reporting something serious. "Waiting on us" and "Reply 3h
   overdue" are the whole register.
   ========================================================================= */

export const money = (minor: number): string =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const dateTime = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export const dayMonth = (iso: string, timeZone: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone, day: '2-digit', month: 'short' });

/** "2h ago" — for a timeline where the exact stamp is noise. */
export function since(iso: string, nowMs = Date.now()): string {
  const delta = nowMs - Date.parse(iso);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* — Status ————————————————————————————————————————————————— */

const STATE_TONE: Record<string, Tone> = {
  open: 'warn',
  pending_staff: 'warn',
  pending_member: 'neutral',
  resolved: 'good',
  closed: 'neutral',
};

/**
 * The two pending states get different words on purpose. "Waiting on us" is
 * work; "Waiting on member" is not. A queue that calls both "pending" hides
 * the difference between a ticket nobody owes anything on and one being
 * ignored.
 */
const STATE_LABEL: Record<string, string> = {
  open: 'Open',
  pending_staff: 'Waiting on us',
  pending_member: 'Waiting on member',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const stateLabel = (state: string): string => STATE_LABEL[state] ?? state;

export function TicketStateChip({ state }: { state: TicketState | string }) {
  return <Chip tone={STATE_TONE[state] ?? 'neutral'}>{stateLabel(state)}</Chip>;
}

const PRIORITY_TONE: Record<string, Tone> = {
  urgent: 'bad',
  high: 'warn',
  normal: 'neutral',
  low: 'neutral',
};

export function PriorityChip({ priority }: { priority: TicketPriority | string }) {
  return (
    <Chip tone={PRIORITY_TONE[priority] ?? 'neutral'} glyph={priority === 'urgent' || priority === 'high'}>
      {priority}
    </Chip>
  );
}

const SLA_TONE: Record<string, Tone> = {
  breached: 'bad',
  due_soon: 'warn',
  on_track: 'good',
  met: 'good',
  none: 'neutral',
};

/**
 * The SLA verdict. Never colour alone — every chip carries its glyph, and the
 * label is a sentence rather than a state name, because "breached" tells a
 * receptionist nothing they can act on and "Reply 3h overdue" does.
 */
export function SlaChip({ state, label }: { state: SlaState | string; label: string }) {
  return <Chip tone={SLA_TONE[state] ?? 'neutral'}>{label}</Chip>;
}

export const CATEGORY_LABEL: Record<string, string> = {
  billing: 'Billing',
  membership: 'Membership',
  facility: 'Facility',
  class: 'Class',
  app: 'App',
  complaint: 'Complaint',
  other: 'Other',
};

export const ACTION_LABEL: Record<string, string> = {
  call: 'Personal call',
  coach_checkin: 'Coach check-in',
  offer_review: 'Review their plan',
  visit_invite: 'Invite them in',
  no_action: 'No action',
};

export const OUTCOME_LABEL: Record<string, string> = {
  retained: 'Stayed',
  churned: 'Left',
  no_contact: 'Could not reach',
  false_positive: 'Not actually at risk',
};

const BAND_TONE: Record<string, Tone> = { high: 'bad', watch: 'warn', low: 'good' };

export function RiskChip({ band, score }: { band: string; score: number }) {
  return (
    <Chip tone={BAND_TONE[band] ?? 'neutral'}>
      {band} · {score}
    </Chip>
  );
}

/**
 * A figure the viewer's role may not see.
 *
 * Same rule as Store: `null` from the API means "your role may not see this",
 * which is not zero and must never render as one.
 */
export function Restricted({ label = 'Restricted' }: { label?: string }): ReactNode {
  return (
    <span
      title="Your role does not include this figure"
      className="font-utility text-[10px] uppercase tracking-[0.12em] text-foam-35"
    >
      {label}
    </span>
  );
}
