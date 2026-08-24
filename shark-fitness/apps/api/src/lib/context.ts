import type { Role } from '@shark/contracts';
import { can, type Permission } from '@shark/domain';
import { forbidden } from './errors.js';

export interface RequestContext {
  requestId: string;
  sessionId: string;
  authMethod: 'cookie' | 'bearer' | 'reader';
  tenantId: string;
  userId: string;
  memberId: string | null;
  staffId: string | null;
  role: Role;
  name: string;
  /** Every branch this caller is entitled to. The ceiling on any scope. */
  branchIds: string[];
  /**
   * The branch the *client explicitly selected for this request*, and nothing
   * else. `null` means no selection, which means every branch in `branchIds`.
   *
   * This used to be seeded at sign-in to the caller's first permitted branch,
   * and that is the whole of the bug it caused. The console's switcher calls
   * "nothing selected" *All branches* and expresses it by sending no
   * `x-branch-id` header — so an owner of three gyms read a screen labelled
   * "All branches (3)" over one gym's figures. Nothing errored; the numbers
   * were simply a third of the truth.
   *
   * Set only by the `authenticate` middleware, from a header that has already
   * been checked against `branchIds`. Read it through `branchScope` rather
   * than directly, so "one branch" and "all branches" cannot drift apart
   * again module by module.
   */
  activeBranchId: string | null;
  permissions: Permission[];
  ip: string;
  userAgent: string;
  impersonatorId: string | null;
}

export function requirePermission(ctx: RequestContext, permission: Permission): void {
  if (!can(ctx.role, permission)) throw forbidden('Your role does not include this action.');
}

export function requireBranch(ctx: { branchIds: string[] }, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw forbidden('You do not have access to this branch.');
}

/**
 * The branches one request covers. The single answer to "which branches?".
 *
 * Four cases, and naming them is the point — the previous arrangement made two
 * of them indistinguishable:
 *
 * - **A branch named in the query** (`requested`) — checked against the
 *   caller's entitlement, then used alone. A report cannot be widened by
 *   asking for a branch the role does not hold.
 * - **A branch selected in the client** (`x-branch-id`) — already checked by
 *   the `authenticate` middleware, so trusted here.
 * - **No selection at all** — every branch the caller may see. This is what
 *   the console means by "All branches", and it must not quietly become one
 *   of them.
 * - **A branch outside the entitlement** — refused in middleware, before any
 *   handler runs. Never silently narrowed to what the caller does hold, which
 *   would answer a question about Indiranagar with Koramangala's figures.
 *
 * A caller with exactly one branch gets that branch either way, which is why
 * this bug survived so long: on a single-branch tenant the two readings agree.
 */
export function branchScope(
  ctx: { branchIds: string[]; activeBranchId?: string | null },
  requested?: string | null,
): string[] {
  if (requested) {
    requireBranch(ctx, requested);
    return [requested];
  }
  return ctx.activeBranchId ? [ctx.activeBranchId] : ctx.branchIds;
}

/** True when a request covers the caller's whole entitlement rather than one
 *  branch of it — the flag a screen needs to label its own scope honestly. */
export function isAllBranches(
  ctx: { activeBranchId: string | null },
  requested?: string | null,
): boolean {
  return !requested && !ctx.activeBranchId;
}

export function requireMemberSelfOrStaff(ctx: RequestContext, memberId: string, permission: Permission): void {
  if (ctx.memberId === memberId) return;
  requirePermission(ctx, permission);
}

export const isStaff = (ctx: RequestContext): boolean => ctx.role !== 'member';

export function requireAssignedMember(ctx: RequestContext, memberTrainerId: string | null): void {
  if (ctx.role !== 'trainer') return;
  if (memberTrainerId !== ctx.staffId) throw forbidden('You can only see members assigned to you.');
}
