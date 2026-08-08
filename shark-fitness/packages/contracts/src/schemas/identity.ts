import { z } from 'zod';
import { AccountState, BranchState, Role, Unit } from '../enums.js';

export const Id = z.string().min(1);
export const IsoDateTime = z.string().datetime({ offset: true });
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const Phone = z.string().regex(/^\+?[0-9 ()-]{7,20}$/, 'enter a valid phone number');
export const Money = z.number().int(); // minor units, always

export const Tenant = z.object({
  id: Id,
  slug: z.string(),
  legalName: z.string(),
  displayName: z.string(),
  plan: z.enum(['starter', 'growth', 'scale', 'enterprise']),
  locale: z.string(),
  currency: z.string().length(3),
  timezone: z.string(),
  status: z.enum(['active', 'trial', 'suspended', 'archived']),
  featureFlags: z.record(z.boolean()),
  quotas: z.record(z.number()),
  unitSystem: Unit,
});
export type Tenant = z.infer<typeof Tenant>;

export const Branch = z.object({
  id: Id,
  tenantId: Id,
  name: z.string(),
  slug: z.string(),
  addressLine: z.string(),
  city: z.string(),
  timezone: z.string(),
  capacity: z.number().int(),
  opensAt: z.string(), // HH:MM local
  closesAt: z.string(),
  state: BranchState,
  amenities: z.array(z.string()),
  phone: z.string().nullable(),
});
export type Branch = z.infer<typeof Branch>;

export const Viewer = z.object({
  userId: Id,
  tenantId: Id,
  memberId: Id.nullable(),
  staffId: Id.nullable(),
  name: z.string(),
  initials: z.string(),
  email: z.string().email().nullable(),
  role: Role,
  accountState: AccountState,
  homeBranchId: Id.nullable(),
  permittedBranchIds: z.array(Id),
  permissions: z.array(z.string()),
  preferences: z.object({
    register: z.enum(['predator', 'plain']),
    unitSystem: Unit,
    theme: z.enum(['dark', 'light', 'system']),
    haptics: z.boolean(),
    reducedMotion: z.boolean(),
  }),
});
export type Viewer = z.infer<typeof Viewer>;

/* — Auth ————————————————————————————————————————————————— */

export const StartOtpInput = z.object({
  identifier: z.string().min(3), // email or phone
  tenantSlug: z.string().optional(),
});
export type StartOtpInput = z.infer<typeof StartOtpInput>;

export const StartOtpResult = z.object({
  challengeId: Id,
  /** Where it went, masked: "a•••@example.com". Never the full contact. */
  sentTo: z.string(),
  expiresInSec: z.number().int(),
  /** Dev/demo builds echo the code so the flow is walkable without a mailer. */
  devCode: z.string().optional(),
});
export type StartOtpResult = z.infer<typeof StartOtpResult>;

export const VerifyOtpInput = z.object({
  challengeId: Id,
  code: z.string().length(6),
});
export type VerifyOtpInput = z.infer<typeof VerifyOtpInput>;

export const PasswordSignInInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type PasswordSignInInput = z.infer<typeof PasswordSignInInput>;

export const SessionInfo = z.object({
  id: Id,
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  userAgent: z.string(),
  ip: z.string(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const ConsentRecord = z.object({
  purpose: z.enum([
    'terms',
    'privacy',
    'marketing_email',
    'marketing_sms',
    'marketing_whatsapp',
    'progress_photos',
    'health_data',
    'community_visibility',
  ]),
  granted: z.boolean(),
  version: z.string(),
  updatedAt: IsoDateTime,
  required: z.boolean(),
  description: z.string(),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;
