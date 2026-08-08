import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { LeadStage } from '@shark/contracts';
import { db, schema } from '../db/client.js';
import { invalid, notFound } from '../lib/errors.js';
import { DAY } from '../lib/time.js';

/**
 * Canonical lead pipeline (PRD "Lead state machine"). `packages/domain` has no
 * equivalent — leads didn't exist when that package was written — so this
 * lives here rather than as a reimplementation inside the route handler.
 *
 * `won` is deliberately unreachable from this table. A lead only becomes
 * `won` as a side effect of `POST /:leadId/convert`, which creates the member
 * atomically in the same transaction — a bare stage move must never be able
 * to produce a "won" lead with no member behind it.
 */
export const LEAD_STAGE_TRANSITIONS: Record<LeadStage, LeadStage[]> = {
  new: ['contacted', 'lost', 'disqualified'],
  contacted: ['qualified', 'nurture', 'lost', 'disqualified'],
  qualified: ['trial_booked', 'nurture', 'lost', 'disqualified'],
  trial_booked: ['trial_completed', 'nurture', 'lost', 'disqualified'],
  trial_completed: ['nurture', 'lost', 'disqualified'],
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

/**
 * Loads a lead scoped to both tenant and branch, and hides branch-scope
 * violations behind the same "not found" response as a genuinely missing
 * lead — a 403 would confirm the record exists in a branch the caller can't
 * see, which is itself a disclosure.
 */
export function loadLeadInScope(
  ctx: { tenantId: string; branchIds: string[] },
  leadId: string,
): typeof schema.leads.$inferSelect {
  const lead = db
    .select()
    .from(schema.leads)
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.tenantId, ctx.tenantId)))
    .get();
  if (!lead || !ctx.branchIds.includes(lead.branchId)) throw notFound('That lead');
  return lead;
}

/** PF-CRM ownership rules: an owner must be active staff in this tenant, and
 *  assigned to the branch the lead belongs to. */
export function assertValidOwner(tenantId: string, ownerId: string, branchId: string): void {
  const row = db
    .select({ accountState: schema.users.accountState, branchIds: schema.staff.branchIds })
    .from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId))
    .where(and(eq(schema.staff.id, ownerId), eq(schema.staff.tenantId, tenantId)))
    .get();
  if (!row) throw invalid('That owner does not exist.');
  if (row.accountState !== 'active') throw invalid("That owner's account is not active.");
  if (!row.branchIds.includes(branchId)) throw invalid('That owner is not assigned to this branch.');
}

/** Same-tenant phone/email match against an existing, non-merged member —
 *  used to block a lead conversion from silently creating a duplicate person. */
export function findExistingMember(
  tenantId: string,
  phoneNormalized: string | null,
  emailNormalized: string | null,
): { id: string; name: string } | null {
  if (!phoneNormalized && !emailNormalized) return null;
  const matches = [
    phoneNormalized ? eq(schema.members.phoneNormalized, phoneNormalized) : null,
    emailNormalized ? eq(schema.members.emailNormalized, emailNormalized) : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  const row = db
    .select({
      id: schema.members.id,
      name: sql<string>`${schema.members.firstName} || ' ' || ${schema.members.lastName}`,
    })
    .from(schema.members)
    .where(and(eq(schema.members.tenantId, tenantId), or(...matches), isNull(schema.members.mergedIntoId)))
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
