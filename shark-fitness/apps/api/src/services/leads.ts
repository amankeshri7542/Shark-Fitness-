import { and, eq, ne, or } from 'drizzle-orm';
import type { LeadStage } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { DAY } from '../lib/time.js';

/**
 * Canonical lead pipeline (PRD "Lead state machine"). `packages/domain` has no
 * equivalent — leads didn't exist when that package was written — so this
 * lives here rather than as a reimplementation inside the route handler.
 */
export const LEAD_STAGE_TRANSITIONS: Record<LeadStage, LeadStage[]> = {
  new: ['contacted', 'lost', 'disqualified'],
  contacted: ['qualified', 'nurture', 'lost', 'disqualified'],
  qualified: ['trial_booked', 'nurture', 'lost', 'disqualified'],
  trial_booked: ['trial_completed', 'nurture', 'lost', 'disqualified'],
  trial_completed: ['won', 'nurture', 'lost', 'disqualified'],
  nurture: ['contacted', 'qualified', 'trial_booked', 'lost', 'disqualified'],
  won: [],
  lost: ['reopened'],
  disqualified: ['reopened'],
  reopened: ['contacted', 'qualified', 'nurture'],
};

const REASON_REQUIRED: LeadStage[] = ['lost', 'disqualified'];

export function canTransitionLead(input: {
  from: LeadStage;
  to: LeadStage;
  reason?: string;
}): { ok: true } | { ok: false; message: string } {
  if (input.from === input.to) return { ok: false, message: 'Already in that stage.' };
  const allowed = LEAD_STAGE_TRANSITIONS[input.from] ?? [];
  if (!allowed.includes(input.to)) {
    return { ok: false, message: `A lead cannot move from ${input.from} to ${input.to} directly.` };
  }
  if (REASON_REQUIRED.includes(input.to) && !input.reason?.trim()) {
    return { ok: false, message: 'A reason is required to mark a lead lost or disqualified.' };
  }
  return { ok: true };
}

/** Same-tenant phone/email match, excluding the lead itself. First-touch
 *  attribution is preserved by the caller — this only *detects*, never merges. */
export function findDuplicateLead(
  tenantId: string,
  phoneNormalized: string | null,
  emailNormalized: string | null,
  excludeLeadId?: string,
): { id: string; name: string } | null {
  if (!phoneNormalized && !emailNormalized) return null;
  const matches = [
    phoneNormalized ? eq(schema.leads.phoneNormalized, phoneNormalized) : null,
    emailNormalized ? eq(schema.leads.emailNormalized, emailNormalized) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  const row = db
    .select({ id: schema.leads.id, name: schema.leads.name })
    .from(schema.leads)
    .where(
      and(
        eq(schema.leads.tenantId, tenantId),
        or(...matches),
        excludeLeadId ? ne(schema.leads.id, excludeLeadId) : undefined,
      ),
    )
    .get();

  return row ?? null;
}

const SLA_STALE_DAYS = 3;

/** PF-CRM-006: a lead is breaching SLA if it has an overdue next action, or
 *  has never been touched within the stale window and isn't in a terminal state. */
export function leadSlaBreached(
  lead: { stage: LeadStage; nextActionAt: number | null; lastTouchedAt: number | null; createdAt: number },
  nowMs: number,
): boolean {
  if (['won', 'lost', 'disqualified'].includes(lead.stage)) return false;
  if (lead.nextActionAt !== null) return lead.nextActionAt < nowMs;
  const lastTouch = lead.lastTouchedAt ?? lead.createdAt;
  return nowMs - lastTouch > SLA_STALE_DAYS * DAY;
}
