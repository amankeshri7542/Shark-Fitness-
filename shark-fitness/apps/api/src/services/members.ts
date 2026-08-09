import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { notFound } from '../lib/errors.js';

/**
 * Member branch scope — shared by attendance search, attendance history,
 * manual check-in and staff class booking, so a member reachable from one
 * desk workflow is reachable from all of them.
 */

/** Home branch plus any explicitly granted extra branches (`member_branches`). */
export function memberBranchIds(member: { id: string; homeBranchId: string }): string[] {
  const extra = db
    .select({ branchId: schema.memberBranches.branchId })
    .from(schema.memberBranches)
    .where(eq(schema.memberBranches.memberId, member.id))
    .all()
    .map((row) => row.branchId);
  return [...new Set([member.homeBranchId, ...extra])];
}

/** A member is reachable when their home branch — or any branch they have
 *  been explicitly added to — is inside the caller's scope. A member of
 *  another region is "not found", never "forbidden": a 403 would confirm the
 *  record exists somewhere the caller cannot see. */
export function loadMemberInScope(
  ctx: { tenantId: string; branchIds: string[] },
  memberId: string,
): typeof schema.members.$inferSelect {
  const member = db
    .select()
    .from(schema.members)
    .where(
      and(
        eq(schema.members.id, memberId),
        eq(schema.members.tenantId, ctx.tenantId),
        isNull(schema.members.deletedAt),
      ),
    )
    .get();
  if (!member) throw notFound('That member');
  if (!memberBranchIds(member).some((branchId) => ctx.branchIds.includes(branchId))) {
    throw notFound('That member');
  }
  return member;
}

/** Member ids reachable via an explicit `member_branches` grant into scope —
 *  the list-query counterpart to `loadMemberInScope`, for search/browse. */
function memberIdsGrantedInto(ctx: { tenantId: string; branchIds: string[] }): string[] {
  if (ctx.branchIds.length === 0) return [];
  return db
    .select({ memberId: schema.memberBranches.memberId })
    .from(schema.memberBranches)
    .where(
      and(eq(schema.memberBranches.tenantId, ctx.tenantId), inArray(schema.memberBranches.branchId, ctx.branchIds)),
    )
    .all()
    .map((row) => row.memberId);
}

/** Where-condition for a member list query: home branch in scope, or an
 *  explicit `member_branches` grant into scope. */
export function memberScopeCondition(ctx: { tenantId: string; branchIds: string[] }) {
  const granted = memberIdsGrantedInto(ctx);
  return granted.length > 0
    ? or(inArray(schema.members.homeBranchId, ctx.branchIds), inArray(schema.members.id, granted))!
    : inArray(schema.members.homeBranchId, ctx.branchIds);
}
