import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AccessRules, CancellationPolicy, FreezeRules, Product } from '@shark/contracts';

export const members = sqliteTable(
  'members',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id'),
    homeBranchId: text('home_branch_id').notNull(),
    memberNo: text('member_no').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    initials: text('initials').notNull(),
    email: text('email'),
    phone: text('phone'),
    /** Normalised for dedup: digits only, last 10. */
    phoneNormalized: text('phone_normalized'),
    emailNormalized: text('email_normalized'),
    dob: text('dob'),
    gender: text('gender'),
    addressLine: text('address_line'),
    emergencyContact: text('emergency_contact', { mode: 'json' })
      .$type<{ name: string; phone: string; relationship: string } | null>(),
    lifecycle: text('lifecycle').notNull().default('active'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    trainerId: text('trainer_id'),
    guardianId: text('guardian_id'),
    corporateSponsorId: text('corporate_sponsor_id'),
    /** Visible to the member. */
    memberNotes: text('member_notes'),
    /** Staff only. Never serialised into a member-scoped response (PF-MEM-006). */
    staffNotes: text('staff_notes'),
    riskScore: integer('risk_score'),
    riskReasons: text('risk_reasons', { mode: 'json' })
      .$type<Array<{ code: string; label: string; points: number }>>(),
    joinedOn: text('joined_on').notNull(),
    lastVisitAt: integer('last_visit_at'),
    /** Set when a merge folded this record into another. */
    mergedIntoId: text('merged_into_id'),
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => ({
    byTenant: index('members_tenant_idx').on(t.tenantId, t.lifecycle),
    byBranch: index('members_branch_idx').on(t.tenantId, t.homeBranchId),
    byPhone: index('members_phone_idx').on(t.tenantId, t.phoneNormalized),
    byEmail: index('members_email_idx').on(t.tenantId, t.emailNormalized),
    memberNoUq: uniqueIndex('members_no_uq').on(t.tenantId, t.memberNo),
    byTrainer: index('members_trainer_idx').on(t.trainerId),
  }),
);

/** Branches a member may enter beyond their home branch. */
export const memberBranches = sqliteTable(
  'member_branches',
  {
    memberId: text('member_id').notNull(),
    branchId: text('branch_id').notNull(),
    tenantId: text('tenant_id').notNull(),
  },
  (t) => ({ uq: uniqueIndex('member_branches_uq').on(t.memberId, t.branchId) }),
);

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    version: integer('version').notNull().default(1),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull().default('INR'),
    taxRateBp: integer('tax_rate_bp').notNull().default(1800),
    cadence: text('cadence').notNull(),
    durationDays: integer('duration_days'),
    credits: integer('credits'),
    creditsExpireDays: integer('credits_expire_days'),
    access: text('access', { mode: 'json' }).$type<AccessRules>().notNull(),
    freeze: text('freeze', { mode: 'json' }).$type<FreezeRules>().notNull(),
    cancellation: text('cancellation', { mode: 'json' }).$type<CancellationPolicy>().notNull(),
    eligibility: text('eligibility', { mode: 'json' })
      .$type<{ minAge: number | null; maxAge: number | null; corporateOnly: boolean; requiresApproval: boolean }>()
      .notNull(),
    branchIds: text('branch_ids', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byTenant: index('products_tenant_idx').on(t.tenantId, t.status) }),
);

export const memberships = sqliteTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    productId: text('product_id').notNull(),
    productName: text('product_name').notNull(),
    /** The purchased terms, frozen. Never rewritten when the catalogue moves. */
    productSnapshot: text('product_snapshot', { mode: 'json' }).$type<Product>().notNull(),
    state: text('state').notNull().default('draft'),
    startedOn: text('started_on').notNull(),
    endsOn: text('ends_on'),
    autoRenew: integer('auto_renew', { mode: 'boolean' }).notNull().default(true),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull().default('INR'),
    freezeDaysUsed: integer('freeze_days_used').notNull().default(0),
    freezeStartedOn: text('freeze_started_on'),
    graceEndsOn: text('grace_ends_on'),
    cancelEffectiveOn: text('cancel_effective_on'),
    previousMembershipId: text('previous_membership_id'),
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    byMember: index('memberships_member_idx').on(t.memberId, t.state),
    byTenantState: index('memberships_tenant_state_idx').on(t.tenantId, t.state, t.endsOn),
  }),
);

export const membershipEvents = sqliteTable(
  'membership_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    membershipId: text('membership_id').notNull(),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    reason: text('reason').notNull(),
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    source: text('source').notNull(),
    effectiveAt: integer('effective_at').notNull(),
  },
  (t) => ({ byMembership: index('membership_events_idx').on(t.membershipId, t.effectiveAt) }),
);

/** Entitlements are tracked apart from payments so a failed or refunded
 *  payment can be resolved deterministically (PF-CAT-005). */
export const credits = sqliteTable(
  'credits',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    memberId: text('member_id').notNull(),
    kind: text('kind').notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    expiresOn: text('expires_on'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byMember: index('credits_member_idx').on(t.memberId, t.kind) }),
);

export const leads = sqliteTable(
  'leads',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    phoneNormalized: text('phone_normalized'),
    emailNormalized: text('email_normalized'),
    source: text('source').notNull(),
    campaign: text('campaign'),
    stage: text('stage').notNull().default('new'),
    ownerId: text('owner_id'),
    expectedValueMinor: integer('expected_value_minor').notNull().default(0),
    nextActionAt: integer('next_action_at'),
    nextActionLabel: text('next_action_label'),
    lastTouchedAt: integer('last_touched_at'),
    lossReason: text('loss_reason'),
    convertedMemberId: text('converted_member_id'),
    duplicateOfId: text('duplicate_of_id'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    byStage: index('leads_stage_idx').on(t.tenantId, t.stage),
    byPhone: index('leads_phone_idx').on(t.tenantId, t.phoneNormalized),
    byOwner: index('leads_owner_idx').on(t.ownerId),
  }),
);

export const leadActivities = sqliteTable(
  'lead_activities',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    leadId: text('lead_id').notNull(),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    fromStage: text('from_stage'),
    toStage: text('to_stage'),
    at: integer('at').notNull(),
  },
  (t) => ({ byLead: index('lead_activities_idx').on(t.leadId, t.at) }),
);

export const staff = sqliteTable(
  'staff',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    employmentStatus: text('employment_status').notNull().default('active'),
    branchIds: text('branch_ids', { mode: 'json' }).$type<string[]>().notNull(),
    specialties: text('specialties', { mode: 'json' }).$type<string[]>().notNull(),
    certifications: text('certifications', { mode: 'json' })
      .$type<Array<{ name: string; expiresOn: string | null }>>()
      .notNull(),
    commissionRules: text('commission_rules', { mode: 'json' })
      .$type<Array<{ kind: string; ratePct: number }>>()
      .notNull(),
    hourlyRateMinor: integer('hourly_rate_minor'),
    joinedOn: text('joined_on').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ byTenant: index('staff_tenant_idx').on(t.tenantId, t.employmentStatus) }),
);

export const shifts = sqliteTable(
  'shifts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    branchId: text('branch_id').notNull(),
    staffId: text('staff_id').notNull(),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    role: text('role').notNull(),
    state: text('state').notNull().default('planned'),
    coveredByStaffId: text('covered_by_staff_id'),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byBranchTime: index('shifts_branch_time_idx').on(t.branchId, t.startsAt) }),
);

export const commissionLines = sqliteTable(
  'commission_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    staffId: text('staff_id').notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    kind: text('kind').notNull(),
    basisMinor: integer('basis_minor').notNull(),
    ratePct: real('rate_pct').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    ruleVersion: text('rule_version').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<string[]>().notNull(),
    state: text('state').notNull().default('accrued'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byStaff: index('commission_staff_idx').on(t.staffId, t.periodStart) }),
);
