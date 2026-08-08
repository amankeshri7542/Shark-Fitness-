import type { Role } from '@shark/contracts';
import { can, type Permission } from '@shark/domain';
import { forbidden } from './errors.js';

/**
 * Request context — Engineering PRD §"Request context".
 *
 * Every repository call takes this. There is no code path that reads a business
 * table without a tenant id, which is what makes shared-shard isolation hold
 * without Postgres row-level security.
 */
export interface RequestContext {
  requestId: string;
  tenantId: string;
  userId: string;
  memberId: string | null;
  staffId: string | null;
  role: Role;
  name: string;
  /** Branches this actor may read or write. A member's is their entitlement
   *  set; a branch manager's is their assignment. */
  branchIds: string[];
  /** The branch currently selected in the UI, when one is. */
  activeBranchId: string | null;
  permissions: Permission[];
  ip: string;
  userAgent: string;
  impersonatorId: string | null;
}

export function requirePermission(ctx: RequestContext, permission: Permission): void {
  if (!can(ctx.role, permission)) {
    throw forbidden('Your role does not include this action.');
  }
}

export function requireBranch(ctx: RequestContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) {
    // Deliberately the same message as a missing record: whether a branch
    // exists in another tenant is not something a caller gets to learn.
    throw forbidden('You do not have access to this branch.');
  }
}

export function requireMemberSelfOrStaff(ctx: RequestContext, memberId: string, permission: Permission): void {
  if (ctx.memberId === memberId) return;
  requirePermission(ctx, permission);
}

export const isStaff = (ctx: RequestContext): boolean => ctx.role !== 'member';

/** Trainers only see the members assigned to them, unless they hold a wider
 *  role. Callers pass the member's trainer id (PF-STAFF-005). */
export function requireAssignedMember(ctx: RequestContext, memberTrainerId: string | null): void {
  if (ctx.role !== 'trainer') return;
  if (memberTrainerId !== ctx.staffId) {
    throw forbidden('You can only see members assigned to you.');
  }
}
