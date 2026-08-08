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
  branchIds: string[];
  activeBranchId: string | null;
  permissions: Permission[];
  ip: string;
  userAgent: string;
  impersonatorId: string | null;
}

export function requirePermission(ctx: RequestContext, permission: Permission): void {
  if (!can(ctx.role, permission)) throw forbidden('Your role does not include this action.');
}

export function requireBranch(ctx: RequestContext, branchId: string): void {
  if (!ctx.branchIds.includes(branchId)) throw forbidden('You do not have access to this branch.');
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
