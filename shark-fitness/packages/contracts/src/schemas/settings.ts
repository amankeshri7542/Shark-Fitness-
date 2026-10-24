import { z } from 'zod';
import { BranchState } from '../enums.js';
import { Id, IsoDate, IsoDateTime } from './identity.js';

/* ============================================================================
   Tenant and branch configuration — PF-TEN-001…006.

   Two rules shape every type below.

   **An override is a key that is present.** A branch either holds a value for
   a setting or it does not, and its absence is what "inherited" means. There
   is no `inherited: boolean` beside the value that could disagree with it, and
   no `null` standing in for "not set" — because `false` and "unset" are
   different answers and collapsing them is how a door ends up open.

   **A change that could reach backwards announces itself first.** Every write
   that can alter how existing records read — a timezone, a currency, closing a
   branch with a timetable on it — answers with `consequences` before it is
   applied, and refuses outright where proceeding would strand data rather than
   merely surprise somebody.
   ========================================================================= */

/** Where a resolved setting came from. `branch` means this branch overrides it. */
export const SettingSource = z.enum(['tenant', 'branch', 'default']);
export type SettingSource = z.infer<typeof SettingSource>;

export const DayKey = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type DayKey = z.infer<typeof DayKey>;

export const DayHours = z.object({
  /** Minutes from local midnight, 0–1440. */
  open: z.number().int().min(0).max(1440),
  close: z.number().int().min(0).max(1440),
  closed: z.boolean(),
});
export type DayHours = z.infer<typeof DayHours>;

export const WeekHours = z.record(DayKey, DayHours);
export type WeekHours = z.infer<typeof WeekHours>;

/* — Business profile (PF-TEN-001, PF-TEN-005) —————————————————— */

export const TaxProfile = z.object({
  /** GSTIN, VAT number — whatever the jurisdiction calls it. */
  registrationNumber: z.string().trim().max(40),
  /** What tax is printed as on an invoice: "GST", "VAT", "Sales tax". */
  label: z.string().trim().min(1).max(24),
  /** Basis points. 1800 = 18%. */
  defaultRateBp: z.number().int().min(0).max(10_000),
  /** True when catalogue prices already include tax. */
  pricesIncludeTax: z.boolean(),
});
export type TaxProfile = z.infer<typeof TaxProfile>;

export const DataProcessing = z.object({
  /** Where a subject-access request goes. */
  privacyContact: z.string().trim().max(160),
  /** Days a departed member's record is kept before anonymisation. */
  retentionDays: z.number().int().min(30).max(3650),
  /** The consent document version in force. Raising it does not re-consent
   *  anyone: consent rows store the version they were granted under. */
  consentVersion: z.string().trim().min(1).max(24),
  /** Free text — the jurisdiction whose rules the tenant operates under. */
  jurisdiction: z.string().trim().max(80),
});
export type DataProcessing = z.infer<typeof DataProcessing>;

export const BusinessProfile = z.object({
  legalName: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(80),
  locale: z.string().trim().min(2).max(12),
  currency: z.string().trim().length(3),
  timezone: z.string().trim().min(1).max(64),
  unitSystem: z.enum(['metric', 'imperial']),
  /** What this tenant calls the things it sells and the people who buy them. */
  terminology: z.record(z.string().max(40)).optional(),
  taxProfile: TaxProfile.nullable(),
  dataProcessing: DataProcessing.nullable(),
});
export type BusinessProfile = z.infer<typeof BusinessProfile>;

export const BusinessProfilePatch = BusinessProfile.partial().extend({
  /** Set once the operator has seen the consequences of a currency change. */
  acknowledge: z.array(z.string()).optional(),
});
export type BusinessProfilePatch = z.infer<typeof BusinessProfilePatch>;

/* — Policy (PF-TEN-003) —————————————————————————————————— */

/** One setting, its value, and whether this branch overrides the tenant. */
export const ResolvedSetting = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string(),
  kind: z.enum(['boolean', 'number', 'time']),
  value: z.union([z.boolean(), z.number(), z.string(), z.null()]),
  source: SettingSource,
  /** What the tenant says, so the console can show what "inherit" restores. */
  tenantValue: z.union([z.boolean(), z.number(), z.string(), z.null()]),
  /** False for a tenant-wide promise a branch may not differ on. */
  overridable: z.boolean(),
});
export type ResolvedSetting = z.infer<typeof ResolvedSetting>;

/* — Branches (PF-TEN-002, PF-TEN-004) ——————————————————————— */

export const BranchDetail = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  addressLine: z.string(),
  city: z.string(),
  timezone: z.string(),
  capacity: z.number().int(),
  opensAt: z.string(),
  closesAt: z.string(),
  hours: WeekHours.nullable(),
  holidays: z.array(IsoDate),
  amenities: z.array(z.string()),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  state: BranchState,
  stateMeaning: z.string(),
  /** Accepts new bookings, check-ins and sales. */
  trades: z.boolean(),
  stateChangedAt: IsoDateTime.nullable(),
  stateNote: z.string().nullable(),
  nextStates: z.array(BranchState),
  rooms: z.array(z.object({ id: Id, name: z.string(), capacity: z.number().int() })),
  settings: z.array(ResolvedSetting),
  /** Counted live, so a stale number never justifies a destructive change. */
  counts: z.object({
    members: z.number().int(),
    grantedMembers: z.number().int(),
    futureBookings: z.number().int(),
    staff: z.number().int(),
    openTickets: z.number().int(),
  }),
});
export type BranchDetail = z.infer<typeof BranchDetail>;

export const BranchInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(48).regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers and hyphens'),
  addressLine: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(80),
  timezone: z.string().trim().min(1).max(64),
  capacity: z.number().int().min(1).max(10_000),
  opensAt: z.string().regex(/^\d{2}:\d{2}$/),
  closesAt: z.string().regex(/^\d{2}:\d{2}$/),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(160).nullable().optional(),
  amenities: z.array(z.string().trim().max(40)).max(40).optional(),
});
export type BranchInput = z.infer<typeof BranchInput>;

export const BranchPatch = BranchInput.partial().extend({
  hours: WeekHours.nullable().optional(),
  holidays: z.array(IsoDate).max(200).optional(),
  /** Overrides only. `null` for a key removes the override and re-inherits. */
  policy: z.record(z.union([z.boolean(), z.number(), z.string(), z.null()])).optional(),
  acknowledge: z.array(z.string()).optional(),
});
export type BranchPatch = z.infer<typeof BranchPatch>;

export const BranchStateInput = z.object({
  state: BranchState,
  note: z.string().trim().min(4).max(400),
  acknowledge: z.array(z.string()).optional(),
});
export type BranchStateInput = z.infer<typeof BranchStateInput>;

/* — Consequences ————————————————————————————————————————— */

/**
 * Something a change does that the operator has to see first.
 *
 * `blocking` is refused until dealt with; otherwise it is acknowledged by
 * echoing its `code` back in `acknowledge`. That echo is deliberate: it means
 * the client cannot skip a warning it never rendered.
 */
export const Consequence = z.object({
  code: z.string(),
  message: z.string(),
  blocking: z.boolean(),
  count: z.number().int().optional(),
});
export type Consequence = z.infer<typeof Consequence>;

export const ConsequenceResponse = z.object({
  ok: z.literal(false),
  consequences: z.array(Consequence),
});
export type ConsequenceResponse = z.infer<typeof ConsequenceResponse>;

/* — Setup (PF-TEN-006) ————————————————————————————————— */

export const ChecklistItem = z.object({
  key: z.string(),
  label: z.string(),
  why: z.string(),
  done: z.boolean(),
  to: z.string(),
  blocking: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const SetupChecklist = z.object({
  items: z.array(ChecklistItem),
  done: z.number().int(),
  total: z.number().int(),
  /** True when nothing blocking is outstanding. */
  readyToOpen: z.boolean(),
});
export type SetupChecklist = z.infer<typeof SetupChecklist>;

/* — Rooms ————————————————————————————————————————————— */

export const RoomInput = z.object({
  name: z.string().trim().min(1).max(60),
  capacity: z.number().int().min(1).max(1000),
});
export type RoomInput = z.infer<typeof RoomInput>;
