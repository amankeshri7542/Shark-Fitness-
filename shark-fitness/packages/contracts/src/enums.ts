import { z } from 'zod';

/* ============================================================================
   Canonical enums. Adding a value requires a migration, an analytics catalogue
   entry, UI states and tests (Engineering PRD §8.3). Do not fork these
   client-side — PF agent contract rule 5.
   ========================================================================= */

export const Role = z.enum([
  'platform_admin',
  'platform_support',
  'owner',
  'regional_manager',
  'branch_manager',
  'reception',
  'trainer',
  'accountant',
  'member',
]);
export type Role = z.infer<typeof Role>;

export const STAFF_ROLES: Role[] = [
  'platform_admin',
  'platform_support',
  'owner',
  'regional_manager',
  'branch_manager',
  'reception',
  'trainer',
  'accountant',
];

export const BranchState = z.enum(['draft', 'active', 'temporarily_closed', 'suspended', 'archived']);
export type BranchState = z.infer<typeof BranchState>;

/** Identity state — distinct from membership state (PF §Member account state). */
export const AccountState = z.enum([
  'invited',
  'active',
  'disabled',
  'deletion_requested',
  'anonymized',
  'legal_hold',
]);
export type AccountState = z.infer<typeof AccountState>;

/** PF §Membership state machine. */
export const MembershipState = z.enum([
  'draft',
  'pending_payment',
  'active',
  'frozen',
  'grace',
  'cancel_scheduled',
  'cancelled',
  'expired',
  'suspended',
]);
export type MembershipState = z.infer<typeof MembershipState>;

export const MemberLifecycle = z.enum([
  'trial',
  'active',
  'frozen',
  'grace',
  'expired',
  'suspended',
  'former',
  'corporate',
  'dependent',
  'digital_only',
]);
export type MemberLifecycle = z.infer<typeof MemberLifecycle>;

export const ProductKind = z.enum([
  'membership',
  'class_pack',
  'pt_credits',
  'trial',
  'day_pass',
  'corporate',
  'digital',
  'addon',
  'retail_bundle',
]);
export type ProductKind = z.infer<typeof ProductKind>;

export const BillingCadence = z.enum(['one_time', 'monthly', 'quarterly', 'half_yearly', 'annual']);
export type BillingCadence = z.infer<typeof BillingCadence>;

export const InvoiceState = z.enum([
  'draft',
  'open',
  'partially_paid',
  'paid',
  'overdue',
  'void',
  'partially_refunded',
  'refunded',
]);
export type InvoiceState = z.infer<typeof InvoiceState>;

export const PaymentState = z.enum([
  'created',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'partially_refunded',
  'refunded',
  'chargeback_open',
  'chargeback_won',
  'chargeback_lost',
]);
export type PaymentState = z.infer<typeof PaymentState>;

export const PaymentMethod = z.enum([
  'cash',
  'card',
  'bank_transfer',
  'upi',
  'wallet',
  'voucher',
  'credit_note',
]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const BookingState = z.enum([
  'held',
  'confirmed',
  'attended',
  'cancelled',
  'late_cancelled',
  'no_show',
]);
export type BookingState = z.infer<typeof BookingState>;

export const WaitlistState = z.enum(['waiting', 'offered', 'confirmed', 'expired', 'declined']);
export type WaitlistState = z.infer<typeof WaitlistState>;

export const SessionState = z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']);
export type SessionState = z.infer<typeof SessionState>;

export const LeadStage = z.enum([
  'new',
  'contacted',
  'qualified',
  'trial_booked',
  'trial_completed',
  'nurture',
  'won',
  'lost',
  'disqualified',
  'reopened',
]);
export type LeadStage = z.infer<typeof LeadStage>;

export const CheckInMethod = z.enum(['qr', 'staff', 'kiosk', 'device', 'manual']);
export type CheckInMethod = z.infer<typeof CheckInMethod>;

/** Every denial reason is a stable code. Copy lives in the client so the API
 *  never leaks security-sensitive detail (Design PRD "Content design"). */
export const AccessDecision = z.enum([
  'granted',
  'denied_membership_inactive',
  'denied_grace_outstanding',
  'denied_branch_not_permitted',
  'denied_outside_hours',
  'denied_capacity',
  'denied_suspended',
  'denied_anti_passback',
  'denied_token_invalid',
  'denied_token_replayed',
]);
export type AccessDecision = z.infer<typeof AccessDecision>;

export const WorkoutState = z.enum(['in_progress', 'completed', 'abandoned']);
export type WorkoutState = z.infer<typeof WorkoutState>;

export const GoalState = z.enum(['active', 'achieved', 'missed', 'paused', 'retired']);
export type GoalState = z.infer<typeof GoalState>;

export const TicketState = z.enum(['open', 'pending_member', 'pending_staff', 'resolved', 'closed']);
export type TicketState = z.infer<typeof TicketState>;

export const TicketPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TicketPriority = z.infer<typeof TicketPriority>;

export const Channel = z.enum(['in_app', 'push', 'email', 'sms', 'whatsapp']);
export type Channel = z.infer<typeof Channel>;

export const Visibility = z.enum(['private', 'team', 'branch', 'tenant']);
export type Visibility = z.infer<typeof Visibility>;

export const ModerationState = z.enum(['visible', 'flagged', 'removed', 'rate_limited']);
export type ModerationState = z.infer<typeof ModerationState>;

export const EquipmentStatus = z.enum(['available', 'in_maintenance', 'out_of_service', 'retired']);
export type EquipmentStatus = z.infer<typeof EquipmentStatus>;

export const WorkOrderState = z.enum(['open', 'assigned', 'in_progress', 'blocked', 'done', 'cancelled']);
export type WorkOrderState = z.infer<typeof WorkOrderState>;

export const Unit = z.enum(['metric', 'imperial']);
export type Unit = z.infer<typeof Unit>;

export const MuscleGroup = z.enum([
  'chest',
  'front_delt',
  'side_delt',
  'rear_delt',
  'lats',
  'traps',
  'upper_back',
  'lower_back',
  'biceps',
  'triceps',
  'forearms',
  'core',
  'glutes',
  'quads',
  'hamstrings',
  'calves',
  'cardio',
]);
export type MuscleGroup = z.infer<typeof MuscleGroup>;

export const Equipment = z.enum([
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'kettlebell',
  'band',
  'smith',
  'cardio_machine',
  'other',
]);
export type Equipment = z.infer<typeof Equipment>;
