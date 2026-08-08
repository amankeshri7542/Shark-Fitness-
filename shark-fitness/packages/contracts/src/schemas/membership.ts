import { z } from 'zod';
import {
  BillingCadence,
  InvoiceState,
  MemberLifecycle,
  MembershipState,
  PaymentMethod,
  PaymentState,
  ProductKind,
} from '../enums.js';
import { Id, IsoDate, IsoDateTime, Money } from './identity.js';

export const MemberSummary = z.object({
  id: Id,
  memberNo: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  initials: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  homeBranchId: Id,
  lifecycle: MemberLifecycle,
  joinedOn: IsoDate,
  tags: z.array(z.string()),
  /** Explainable, 0–100. Always shown with its reasons, never bare. */
  riskScore: z.number().int().min(0).max(100).nullable(),
  lastVisitAt: IsoDateTime.nullable(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const MemberProfile = MemberSummary.extend({
  dob: IsoDate.nullable(),
  gender: z.string().nullable(),
  addressLine: z.string().nullable(),
  emergencyContact: z
    .object({ name: z.string(), phone: z.string(), relationship: z.string() })
    .nullable(),
  permittedBranchIds: z.array(Id),
  trainerId: Id.nullable(),
  /** Visible to the member. Distinct from staffNotes. */
  memberNotes: z.string().nullable(),
  /** Staff-only. Never serialised to a member token (PF-MEM-006). */
  staffNotes: z.string().nullable().optional(),
  guardianOf: z.array(Id).optional(),
  guardianId: Id.nullable().optional(),
  corporateSponsorId: Id.nullable().optional(),
});
export type MemberProfile = z.infer<typeof MemberProfile>;

/* — Catalogue ——————————————————————————————————————————————— */

export const AccessRules = z.object({
  allBranches: z.boolean(),
  branchIds: z.array(Id),
  /** Minutes past midnight, branch-local. Null means all opening hours. */
  windowStartMin: z.number().int().nullable(),
  windowEndMin: z.number().int().nullable(),
  visitsPerWeek: z.number().int().nullable(),
  guestPassesPerMonth: z.number().int(),
  classPriorityTier: z.number().int(),
  bookingWindowHours: z.number().int(),
});
export type AccessRules = z.infer<typeof AccessRules>;

export const FreezeRules = z.object({
  allowed: z.boolean(),
  maxDaysPerTerm: z.number().int(),
  minDaysPerFreeze: z.number().int(),
  /** When true, freezing pushes the end date out by the frozen duration. */
  extendsExpiry: z.boolean(),
  feeMinor: Money,
});
export type FreezeRules = z.infer<typeof FreezeRules>;

export const CancellationPolicy = z.object({
  noticeDays: z.number().int(),
  commitmentMonths: z.number().int(),
  earlyExitFeeMinor: Money,
  refundable: z.boolean(),
  description: z.string(),
});
export type CancellationPolicy = z.infer<typeof CancellationPolicy>;

export const Product = z.object({
  id: Id,
  kind: ProductKind,
  name: z.string(),
  description: z.string(),
  version: z.number().int(),
  priceMinor: Money,
  currency: z.string().length(3),
  taxRateBp: z.number().int(),
  cadence: BillingCadence,
  durationDays: z.number().int().nullable(),
  credits: z.number().int().nullable(),
  creditsExpireDays: z.number().int().nullable(),
  access: AccessRules,
  freeze: FreezeRules,
  cancellation: CancellationPolicy,
  eligibility: z.object({
    minAge: z.number().int().nullable(),
    maxAge: z.number().int().nullable(),
    corporateOnly: z.boolean(),
    requiresApproval: z.boolean(),
  }),
  status: z.enum(['draft', 'active', 'retired']),
  branchIds: z.array(Id),
});
export type Product = z.infer<typeof Product>;

/** Purchased terms are frozen at purchase and never rewritten when the
 *  catalogue changes (PF-CAT-003). */
export const Membership = z.object({
  id: Id,
  memberId: Id,
  productId: Id,
  productName: z.string(),
  productSnapshot: Product,
  state: MembershipState,
  startedOn: IsoDate,
  endsOn: IsoDate.nullable(),
  autoRenew: z.boolean(),
  priceMinor: Money,
  currency: z.string().length(3),
  freezeDaysUsed: z.number().int(),
  graceEndsOn: IsoDate.nullable(),
  cancelEffectiveOn: IsoDate.nullable(),
  previousMembershipId: Id.nullable(),
});
export type Membership = z.infer<typeof Membership>;

export const MembershipTransition = z.object({
  id: Id,
  membershipId: Id,
  from: MembershipState,
  to: MembershipState,
  reason: z.string(),
  actorName: z.string(),
  effectiveAt: IsoDateTime,
  source: z.enum(['staff', 'member', 'system', 'provider']),
});
export type MembershipTransition = z.infer<typeof MembershipTransition>;

export const CreditBalance = z.object({
  kind: z.enum(['class', 'pt', 'guest']),
  balance: z.number().int(),
  expiresOn: IsoDate.nullable(),
});
export type CreditBalance = z.infer<typeof CreditBalance>;

/* — Billing ————————————————————————————————————————————————— */

export const InvoiceLine = z.object({
  id: Id,
  description: z.string(),
  quantity: z.number().int(),
  unitMinor: Money,
  taxRateBp: z.number().int(),
  taxMinor: Money,
  totalMinor: Money,
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const Invoice = z.object({
  id: Id,
  number: z.string(),
  memberId: Id,
  memberName: z.string().optional(),
  state: InvoiceState,
  issuedOn: IsoDate,
  dueOn: IsoDate,
  currency: z.string().length(3),
  subtotalMinor: Money,
  taxMinor: Money,
  totalMinor: Money,
  paidMinor: Money,
  refundedMinor: Money,
  lines: z.array(InvoiceLine),
});
export type Invoice = z.infer<typeof Invoice>;

export const Payment = z.object({
  id: Id,
  invoiceId: Id.nullable(),
  memberId: Id,
  method: PaymentMethod,
  state: PaymentState,
  amountMinor: Money,
  currency: z.string().length(3),
  provider: z.string().nullable(),
  providerRef: z.string().nullable(),
  recordedByName: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: IsoDateTime,
  settledAt: IsoDateTime.nullable(),
});
export type Payment = z.infer<typeof Payment>;

export const RecordPaymentInput = z.object({
  invoiceId: Id,
  method: PaymentMethod,
  amountMinor: Money.positive(),
  reference: z.string().optional(),
  note: z.string().optional(),
  /** Required. Two staff recording the same cash payment must collide. */
  idempotencyKey: z.string().min(8),
});
export type RecordPaymentInput = z.infer<typeof RecordPaymentInput>;

export const CheckoutIntent = z.object({
  intentId: Id,
  invoiceId: Id,
  amountMinor: Money,
  currency: z.string().length(3),
  provider: z.string(),
  /** Demo provider: a token the client posts back to confirm. Real providers
   *  return a hosted-checkout URL here instead. */
  clientToken: z.string(),
  expiresAt: IsoDateTime,
});
export type CheckoutIntent = z.infer<typeof CheckoutIntent>;

export const DunningAttempt = z.object({
  id: Id,
  invoiceId: Id,
  attempt: z.number().int(),
  scheduledFor: IsoDateTime,
  state: z.enum(['scheduled', 'sent', 'succeeded', 'failed', 'stopped']),
  channel: z.string(),
});
export type DunningAttempt = z.infer<typeof DunningAttempt>;
