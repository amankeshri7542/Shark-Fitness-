import { and, eq, sql } from 'drizzle-orm';
import { deriveState } from '@shark/domain';
import { channels, type MembershipState } from '@shark/contracts';
import { db, schema, transact } from '../db/client.js';
import { emit } from '../lib/events.js';
import { id } from '../lib/ids.js';
import { addDays, isoDate, now } from '../lib/time.js';
import { branchTimeZone } from '../lib/branch-time.js';

/** Reconcile on reads as well as the scheduler: a missed job cannot extend access. */
export function reconcileMembershipDates(memberId?: string): number {
  const rows = db.select().from(schema.memberships).where(and(
    memberId ? eq(schema.memberships.memberId, memberId) : undefined,
    sql`${schema.memberships.state} in ('active','grace','frozen','cancel_scheduled')`,
  )).all();
  let changed = 0;
  for (const membership of rows) {
    const member = db.select().from(schema.members).where(eq(schema.members.id, membership.memberId)).get();
    if (!member) continue;
    const tenant = db.select().from(schema.tenants).where(eq(schema.tenants.id, membership.tenantId)).get();
    const today = isoDate(now(), branchTimeZone(membership.tenantId, member.homeBranchId));
    const outstanding = db.select({ id: schema.invoices.id }).from(schema.invoices).where(and(
      eq(schema.invoices.memberId, member.id), eq(schema.invoices.voided, false),
      sql`${schema.invoices.totalMinor} > ${schema.invoices.paidMinor}`,
    )).get();
    const next = deriveState({ current: membership.state as MembershipState, endsOn: membership.endsOn, today,
      cancelEffectiveOn: membership.cancelEffectiveOn, freezeEndsOn: membership.freezeEndsOn,
      graceDays: Number((tenant?.policy as Record<string, unknown>)?.graceDays ?? 7),
      hasOutstandingBalance: Boolean(outstanding) });
    if (next === membership.state) continue;
    transact(() => {
      db.update(schema.memberships).set({ state: next, updatedAt: now(), version: membership.version + 1,
        graceEndsOn: next === 'grace' && membership.endsOn ? addDays(membership.endsOn, Number((tenant?.policy as Record<string, unknown>)?.graceDays ?? 7)) : null,
        ...(membership.state === 'frozen' ? { freezeStartedOn: null, freezeEndsOn: null } : {}),
      }).where(eq(schema.memberships.id, membership.id)).run();
      db.insert(schema.membershipEvents).values({ id: id('mev'), tenantId: membership.tenantId,
        membershipId: membership.id, fromState: membership.state, toState: next,
        reason: next === 'cancelled' ? 'Cancellation notice completed' : membership.state === 'frozen' ? 'Timed freeze completed' : 'Term ended',
        actorId: null, actorName: 'System', source: 'system', effectiveAt: now(),
      }).run();
      db.update(schema.members).set({ lifecycle: next === 'cancelled' || next === 'expired' ? 'former' : 'active', updatedAt: now() })
        .where(eq(schema.members.id, member.id)).run();
    });
    emit({ tenantId: membership.tenantId, channel: channels.member(member.id), topic: 'membership.state_changed',
      payload: { membershipId: membership.id, from: membership.state, to: next } });
    changed += 1;
  }
  return changed;
}
