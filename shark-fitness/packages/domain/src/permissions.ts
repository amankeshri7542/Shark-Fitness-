import type { Role } from '@shark/contracts';

/**
 * Permissions — Engineering PRD §"Authorization sequence".
 *
 * Coarse role → permission mapping. Every check also runs a tenant and branch
 * scope test in the repository layer; this table alone never grants access to
 * a record, it only says which verbs a role may attempt.
 */

export const PERMISSIONS = [
  'dashboard.view',
  'member.view',
  'member.edit',
  'member.merge',
  'member.delete',
  'member.notes.private',
  'membership.manage',
  'product.manage',
  'billing.view',
  'billing.record_payment',
  'billing.refund',
  'billing.write_off',
  'attendance.view',
  'attendance.checkin',
  'attendance.override',
  'schedule.view',
  'schedule.manage',
  'booking.manage_others',
  'staff.view',
  'staff.manage',
  'staff.commission',
  /** Separated from viewing on purpose: whoever calculates and reads a
   *  commission run must not also be the person who signs it off. Owner and
   *  platform admin hold it; a regional manager who can see the figures
   *  deliberately cannot approve or pay them. */
  'staff.commission.approve',
  'training.view',
  'training.assign',
  'training.program.manage',
  'training.notes.private',
  'lead.view',
  'lead.manage',
  'community.moderate',
  'support.manage',
  /** Read and reply to member conversations: the coach's own threads, the
   *  branch desk's threads for front-of-house and managers (P07). */
  'inbox.view',
  /** See the task queue and work your own tasks. */
  'task.view',
  /** Create tasks for others, reassign and cancel any task in scope. */
  'task.manage',
  /** Compose, preview and send a one-off broadcast (PF-COMM-006). */
  'broadcast.send',
  /** Release a broadcast above the gym's approval threshold. Owner only. */
  'broadcast.approve',
  'inventory.view',
  'inventory.manage',
  'facility.view',
  'facility.manage',
  'report.view',
  'report.financial',
  'report.export',
  'automation.manage',
  'settings.manage',
  'audit.view',
  'platform.admin',
  'platform.impersonate',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS] as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  platform_admin: ALL,
  platform_support: ['dashboard.view', 'member.view', 'report.view', 'audit.view', 'platform.impersonate'],
  owner: ALL.filter((p) => p !== 'platform.admin' && p !== 'platform.impersonate'),
  regional_manager: [
    'dashboard.view',
    'member.view', 'member.edit', 'member.merge', 'member.notes.private',
    'membership.manage', 'product.manage',
    'billing.view', 'billing.record_payment', 'billing.refund',
    'attendance.view', 'attendance.checkin', 'attendance.override',
    'schedule.view', 'schedule.manage', 'booking.manage_others',
    'staff.view', 'staff.manage', 'staff.commission',
    'training.view', 'training.assign', 'training.program.manage',
    'lead.view', 'lead.manage',
    'community.moderate', 'support.manage',
    'inbox.view', 'task.view', 'task.manage', 'broadcast.send',
    'inventory.view', 'inventory.manage',
    'facility.view', 'facility.manage',
    'report.view', 'report.financial', 'report.export',
    'automation.manage', 'audit.view',
  ],
  branch_manager: [
    'dashboard.view',
    'member.view', 'member.edit', 'member.notes.private',
    'membership.manage',
    'billing.view', 'billing.record_payment',
    'attendance.view', 'attendance.checkin', 'attendance.override',
    'schedule.view', 'schedule.manage', 'booking.manage_others',
    'staff.view',
    'training.view', 'training.assign',
    'lead.view', 'lead.manage',
    'community.moderate', 'support.manage',
    'inbox.view', 'task.view', 'task.manage', 'broadcast.send',
    'inventory.view', 'inventory.manage',
    'facility.view', 'facility.manage',
    'report.view', 'report.export',
  ],
  reception: [
    'dashboard.view',
    'member.view', 'member.edit',
    'membership.manage',
    'billing.view', 'billing.record_payment',
    'attendance.view', 'attendance.checkin',
    'schedule.view', 'booking.manage_others',
    'lead.view', 'lead.manage',
    'inventory.view',
    'support.manage',
    'inbox.view', 'task.view', 'task.manage',
  ],
  // Trainers see their assigned members only. The scope test in the repository
  // enforces that; this list only says which verbs they may attempt at all.
  trainer: [
    'dashboard.view',
    'member.view',
    'attendance.view',
    'schedule.view',
    'training.view', 'training.assign', 'training.program.manage', 'training.notes.private',
    'facility.view',
    'inbox.view', 'task.view',
  ],
  accountant: [
    'dashboard.view',
    'member.view',
    'billing.view', 'billing.record_payment', 'billing.refund', 'billing.write_off',
    'report.view', 'report.financial', 'report.export',
    'inventory.view',
    'audit.view',
    'task.view',
  ],
  member: [],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role];
}

/** Navigation is permission-aware — reception should not see sixteen modules
 *  when they need five (Design PRD §3.1). */
export interface NavModule {
  key: string;
  label: string;
  to: string;
  permission: Permission;
}

export const ADMIN_NAV: NavModule[] = [
  { key: 'home', label: 'Command', to: '/', permission: 'dashboard.view' },
  { key: 'tasks', label: 'Tasks', to: '/tasks', permission: 'task.view' },
  { key: 'inbox', label: 'Inbox', to: '/inbox', permission: 'inbox.view' },
  { key: 'leads', label: 'Leads', to: '/leads', permission: 'lead.view' },
  { key: 'members', label: 'Members', to: '/members', permission: 'member.view' },
  { key: 'memberships', label: 'Plans', to: '/plans', permission: 'product.manage' },
  { key: 'billing', label: 'Billing', to: '/billing', permission: 'billing.view' },
  { key: 'attendance', label: 'Floor', to: '/floor', permission: 'attendance.view' },
  { key: 'schedule', label: 'Schedule', to: '/schedule', permission: 'schedule.view' },
  { key: 'training', label: 'Training', to: '/training', permission: 'training.view' },
  { key: 'coaching', label: 'Nutrition & Habits', to: '/coaching', permission: 'training.assign' },
  { key: 'community', label: 'Community', to: '/community', permission: 'community.moderate' },
  { key: 'staff', label: 'Staff', to: '/staff', permission: 'staff.view' },
  { key: 'store', label: 'Store', to: '/store', permission: 'inventory.view' },
  { key: 'equipment', label: 'Equipment', to: '/equipment', permission: 'facility.view' },
  { key: 'marketing', label: 'Marketing', to: '/marketing', permission: 'broadcast.send' },
  { key: 'automations', label: 'Automations', to: '/automations', permission: 'automation.manage' },
  { key: 'reports', label: 'Reports', to: '/reports', permission: 'report.view' },
  { key: 'support', label: 'Support', to: '/support', permission: 'support.manage' },
  { key: 'settings', label: 'Settings', to: '/settings', permission: 'settings.manage' },
  { key: 'platform', label: 'Platform', to: '/platform', permission: 'platform.admin' },
];

/**
 * The rail for roles whose permissions open more modules than their day needs
 * (Design PRD §3.1: "Reception staff should not see sixteen modules when they
 * only need five"). Everything else their permissions allow stays one ⌘K away
 * (`modulesFor`), and Tasks is always in the status strip as "My tasks".
 */
const RAIL_FOCUS: Partial<Record<Role, string[]>> = {
  reception: ['home', 'inbox', 'members', 'attendance', 'billing', 'schedule', 'leads'],
};

/** Roles that operate the product rather than use it. They have no gym. */
const PLATFORM_ROLES: Role[] = ['platform_admin', 'platform_support'];

/**
 * The modules a role sees.
 *
 * Permission-driven, with one carve-out. A platform operator holds every
 * permission — `platform_admin` is `ALL` — but their tenant contains no gym,
 * so fifteen of the sixteen modules would open on an empty screen for a
 * building that does not exist. They get the platform console and reach a
 * customer's own modules by entering that customer's account, which is what
 * support access is for and what the audit trail is written against.
 *
 * `platform_support` reaches the same console with less in it: they may find
 * an account and enter it, and may not administer anybody.
 */
export function navFor(role: Role): NavModule[] {
  const modules = modulesFor(role);
  const focus = RAIL_FOCUS[role];
  return focus ? modules.filter((m) => focus.includes(m.key)) : modules;
}

/** Every module a role may open, rail or not — what the command palette lists. */
export function modulesFor(role: Role): NavModule[] {
  if (PLATFORM_ROLES.includes(role)) {
    return [{ key: 'platform', label: 'Platform', to: '/platform', permission: 'platform.impersonate' }];
  }
  return ADMIN_NAV.filter((m) => can(role, m.permission));
}
