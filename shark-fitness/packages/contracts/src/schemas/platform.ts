import { z } from 'zod';
import { Id, IsoDateTime } from './identity.js';

/* ============================================================================
   Platform administration — PF-PLAT-001…006.

   Every shape here crosses a tenant boundary, which no other contract in this
   product does. That is the reason they live in their own file: a type that
   carries another gym's data should be impossible to reach for by accident
   from a tenant-scoped handler.
   ========================================================================= */

export const TenantStatus = z.enum(['active', 'trial', 'suspended', 'archived']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const MeterHealth = z.enum(['ok', 'approaching', 'exceeded', 'unmetered']);
export type MeterHealth = z.infer<typeof MeterHealth>;

export const TenantMeter = z.object({
  meter: z.string(),
  period: z.string(),
  used: z.number().int(),
  limit: z.number().int(),
  health: MeterHealth,
  /** Null when the meter is unmetered — not zero, which reads as "none used". */
  percent: z.number().int().nullable(),
});
export type TenantMeter = z.infer<typeof TenantMeter>;

/** One row of the customer list. Counts are live, never cached. */
export const TenantSummary = z.object({
  id: Id,
  slug: z.string(),
  displayName: z.string(),
  legalName: z.string(),
  plan: z.string(),
  status: TenantStatus,
  statusMeaning: z.string(),
  operational: z.boolean(),
  billable: z.boolean(),
  currency: z.string(),
  createdAt: IsoDateTime,
  counts: z.object({
    branches: z.number().int(),
    activeBranches: z.number().int(),
    members: z.number().int(),
    staff: z.number().int(),
    /** Check-ins in the last 30 days — the honest "is anybody using this". */
    checkIns30d: z.number().int(),
  }),
  /** Meters at or past 80% of their quota. The reason to look at this row. */
  metersNeedingAttention: z.array(TenantMeter),
});
export type TenantSummary = z.infer<typeof TenantSummary>;

export const TenantDetail = TenantSummary.extend({
  timezone: z.string(),
  locale: z.string(),
  featureFlags: z.record(z.boolean()),
  quotas: z.record(z.number()),
  meters: z.array(TenantMeter),
  nextStatuses: z.array(TenantStatus),
  /** Accounts a court or regulator has frozen. Blocks offboarding outright. */
  legalHolds: z.number().int(),
  /** What suspending would and would not interrupt, in plain words. */
  suspensionNotice: z.string(),
  owners: z.array(z.object({ id: Id, name: z.string(), email: z.string().nullable(), role: z.string(), accountState: z.string() })),
  recentActions: z.array(
    z.object({ at: IsoDateTime, actorName: z.string(), action: z.string(), reason: z.string().nullable() }),
  ),
});
export type TenantDetail = z.infer<typeof TenantDetail>;

export const TenantStatusInput = z.object({
  status: TenantStatus,
  reason: z.string().trim().min(8).max(400),
  /** PF-PLAT-001 asks for an approval trail on destructive tenant changes. */
  approvedBy: z.string().trim().max(120).optional(),
});
export type TenantStatusInput = z.infer<typeof TenantStatusInput>;

export const EntitlementsInput = z.object({
  plan: z.enum(['starter', 'growth', 'scale', 'enterprise']).optional(),
  featureFlags: z.record(z.boolean()).optional(),
  quotas: z.record(z.number().int().min(0)).optional(),
  reason: z.string().trim().min(4).max(400),
});
export type EntitlementsInput = z.infer<typeof EntitlementsInput>;

/* — Support access (PF-PLAT-004) ————————————————————————— */

export const ImpersonateInput = z.object({
  userId: Id,
  reason: z.string().trim().min(8).max(400),
});
export type ImpersonateInput = z.infer<typeof ImpersonateInput>;

export const ImpersonationSession = z.object({
  tenantId: Id,
  tenantName: z.string(),
  userId: Id,
  userName: z.string(),
  role: z.string(),
  expiresAt: IsoDateTime,
  minutesRemaining: z.number().int(),
});
export type ImpersonationSession = z.infer<typeof ImpersonationSession>;

/** What the console needs to draw the banner. Present on `/me` while active. */
export const ImpersonationBanner = z.object({
  active: z.literal(true),
  operatorName: z.string(),
  tenantName: z.string(),
  userName: z.string(),
  minutesRemaining: z.number().int(),
  expiresAt: IsoDateTime,
});
export type ImpersonationBanner = z.infer<typeof ImpersonationBanner>;

/* — Health (PF-PLAT-003) ————————————————————————————— */

export const PlatformHealth = z.object({
  computedAt: IsoDateTime,
  tenants: z.object({ total: z.number().int(), active: z.number().int(), trial: z.number().int(), suspended: z.number().int(), archived: z.number().int() }),
  members: z.number().int(),
  checkIns24h: z.number().int(),
  /** Jobs the scheduler has registered, so a silent scheduler is visible. */
  jobs: z.array(z.object({ name: z.string(), everyMinutes: z.number().int() })),
  /** Outbox rows not yet delivered — the queue depth this product actually has. */
  outboxPending: z.number().int(),
  /** Support sessions open right now, across every tenant. */
  activeSupportSessions: z.number().int(),
  metersNeedingAttention: z.array(TenantMeter.extend({ tenantId: Id, tenantName: z.string() })),
});
export type PlatformHealth = z.infer<typeof PlatformHealth>;
